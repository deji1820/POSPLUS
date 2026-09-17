/**
 * Controlled Node scheduler for the nightly maintenance jobs (SPEC.md §10
 * "Use Railway cron or a controlled Node scheduler according to the
 * deployment environment", issue #33).
 *
 * Runs inside the worker process and enqueues the eight nightly jobs
 * (lib/scheduler/nightly.ts) onto their BullMQ queues. Two deployment
 * shapes are supported:
 *
 *   - default: fire every SCHEDULER_INTERVAL_SECONDS (compressed in dev,
 *     e.g. 30s, to exercise the full nightly cycle on a dev timer — the
 *     issue's acceptance path), otherwise nightly at NIGHTLY_AT local time
 *     (default 02:00, then every 24h);
 *   - disabled: SCHEDULER_ENABLED=false, for environments where an external
 *     cron enqueues the jobs instead.
 *
 * Multi-replica safety: each tick tries to acquire a Redis leader lock
 * (`SET scheduler:leader NX PX <ttl>`); only the holder enqueues, so N
 * worker replicas never fire the batch N times. A replica that loses the
 * lock simply skips its tick. If Redis is unreachable the tick is skipped
 * with a log line — the queues live in Redis anyway, so firing would be
 * pointless.
 */
import { Redis } from "ioredis";

import { redisConnectionOpts } from "@/lib/queue/config";
import { enqueueNightlyJobs, fireIdFor } from "@/lib/scheduler/nightly";
import { jobLog } from "@/worker/log";

const LEADER_KEY = "scheduler:leader";
const LEADER_TTL_MS = 10 * 60 * 1000;

/** Minimal Redis surface the leader lock needs (ioredis satisfies this). */
export interface LockClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: "PX",
    ttl: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  pexpire(key: string, ttl: number): Promise<unknown>;
}

/**
 * Acquire the leader lock, renewing it when this instance already holds it
 * (NX alone would starve our own next tick — the key we set is still
 * present) and yielding only to a DIFFERENT holder. Returns false on any
 * Redis error or contention.
 */
export async function acquireOrRenewLock(
  client: LockClient,
  key: string,
  ttlMs: number,
  instanceId: string,
): Promise<boolean> {
  try {
    const holder = await client.get(key);
    if (holder === instanceId) {
      await client.pexpire(key, ttlMs);
      return true;
    }
    if (holder !== null) return false;
    const reply = await client.set(key, instanceId, "PX", ttlMs, "NX");
    return reply === "OK";
  } catch {
    return false;
  }
}

export interface SchedulerHandle {
  /** Stop timers and release the Redis client. */
  stop: () => Promise<void>;
}

export function schedulerEnabled(): boolean {
  return process.env.SCHEDULER_ENABLED !== "false";
}

/**
 * Seconds between fires when SCHEDULER_INTERVAL_SECONDS is set; null → the
 * NIGHTLY_AT daily schedule. Values below 5s are clamped (dev compression
 * should not hammer the queues).
 */
export function intervalSeconds(): number | null {
  const raw = process.env.SCHEDULER_INTERVAL_SECONDS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(parsed, 5);
}

/** "HH:MM" local → next occurrence from `from`. Exported for tests. */
export function nextDailyFire(at: string, from: Date = new Date()): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  const hours = match ? Number(match[1]) : 2;
  const minutes = match ? Number(match[2]) : 0;
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function nightlyAt(): string {
  return process.env.NIGHTLY_AT?.trim() || "02:00";
}

async function tryAcquireLeader(redis: Redis, instanceId: string): Promise<boolean> {
  return acquireOrRenewLock(redis, LEADER_KEY, LEADER_TTL_MS, instanceId);
}

/** Start the scheduler loop. Resolves once the first tick is scheduled. */
export async function startScheduler(): Promise<SchedulerHandle> {
  const opts = redisConnectionOpts();
  const redis = new Redis({
    host: opts.host,
    port: opts.port,
    username: opts.username,
    password: opts.password,
    db: opts.db,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on("error", () => {
    // Reachability is decided per-tick; this only prevents unhandled events.
  });

  const instanceId = `${process.pid}-${Date.now()}`;
  const interval = intervalSeconds();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tick(trigger: string): Promise<void> {
    if (stopped) return;
    const fireId = fireIdFor();
    if (!(await tryAcquireLeader(redis, instanceId))) {
      // Distinguish "another replica holds the lock" from "redis is down"
      // so operators don't chase the wrong cause.
      let reason = "another replica holds the scheduler lock";
      try {
        await redis.ping();
      } catch {
        reason = "redis unreachable";
      }
      jobLog("scheduler", "tick skipped", { trigger, fireId, reason });
      return;
    }
    try {
      const result = await enqueueNightlyJobs(fireId);
      jobLog("scheduler", "nightly jobs enqueued", {
        trigger,
        fireId,
        enqueued: result.enqueued.length,
        failures: result.failures.map((f) => f.name),
      });
    } catch (error) {
      jobLog("scheduler", "nightly enqueue failed", {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    if (interval !== null) {
      // Compressed dev timer: first fire immediately, then every interval.
      timer = setTimeout(() => {
        void tick("interval").finally(scheduleNext);
      }, timer === null ? 0 : interval * 1000);
      return;
    }
    const next = nextDailyFire(nightlyAt());
    const delay = Math.max(next.getTime() - Date.now(), 0);
    timer = setTimeout(() => {
      void tick("daily").finally(scheduleNext);
    }, delay);
  }

  await redis.connect().catch(() => undefined);
  scheduleNext();
  jobLog("scheduler", "started", {
    instanceId,
    mode: interval !== null ? `every ${interval}s` : `nightly at ${nightlyAt()}`,
  });

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        const holder = await redis.get(LEADER_KEY);
        if (holder === instanceId) await redis.del(LEADER_KEY);
      } catch {
        // best-effort release
      }
      redis.disconnect();
    },
  };
}
