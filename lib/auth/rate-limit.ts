/**
 * Fixed-window rate limiter for auth + public webhook endpoints (SPEC.md §18,
 * §22). Redis-backed so the limit is shared across every web process
 * (the in-memory predecessor reset whenever a replica restarted and allowed
 * N×replicas abuse — replaced in the #34 hardening pass).
 *
 * Behavior:
 *   - `checkRateLimit(key, limit, windowMs)` is true while fewer than `limit`
 *     hits landed in the current window (per `key`), false afterwards.
 *   - Redis unreachable → degrades to a per-process in-memory limiter rather
 *     than failing auth closed or open: the limit still holds per replica,
 *     and the degradation is logged once.
 *   - `RATE_LIMIT_BACKEND=memory` forces the in-memory path (tests, local
 *     scripts without Redis).
 *
 * Keys are namespaced `rl:<key>` and expire with the window, so the store
 * stays bounded.
 */
import { Redis } from "ioredis";

import { redisConnectionOpts } from "@/lib/queue/config";

import { jobLog } from "@/worker/log";

type Bucket = { count: number; resetAt: number };

/** Per-process fallback buckets (Redis unavailable / forced memory mode). */
const memoryBuckets = new Map<string, Bucket>();

let redisClient: Redis | null | undefined; // undefined = not initialized
let redisDownLogged = false;

function forceMemoryBackend(): boolean {
  return process.env.RATE_LIMIT_BACKEND === "memory";
}

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  if (forceMemoryBackend()) {
    redisClient = null;
    return null;
  }
  try {
    const opts = redisConnectionOpts();
    redisClient = new Redis({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      db: opts.db,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    redisClient.on("error", () => {
      // Swallowed: reachability is decided by the check path below; this
      // handler only prevents unhandled 'error' events from crashing the process.
    });
    return redisClient;
  } catch {
    redisClient = null;
    return null;
  }
}

/** Redis broke mid-flight: stop trying for the life of this process. */
function markRedisUnavailable(reason: string): void {
  if (!redisDownLogged) {
    redisDownLogged = true;
    jobLog("rate-limit", "rate limiter degraded to in-memory backend", { reason });
  }
  try {
    redisClient?.disconnect();
  } catch {
    // disconnect is best-effort
  }
  redisClient = null;
}

function memoryCheck(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/**
 * Fixed window, shared via Redis when reachable. Returns true when the call
 * is within `limit` for the current window.
 */
export async function checkRateLimit(
  key: string,
  limit = 10,
  windowMs = 5 * 60 * 1000,
): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      if (redis.status === "wait") await redis.connect();
      const count = await redis.incr(`rl:${key}`);
      if (count === 1) await redis.pexpire(`rl:${key}`, windowMs);
      return count <= limit;
    } catch (error) {
      markRedisUnavailable(error instanceof Error ? error.message : String(error));
    }
  }
  return memoryCheck(key, limit, windowMs);
}

/** Test hook: clear fallback buckets and forget any Redis client state. */
export function resetRateLimits(): void {
  memoryBuckets.clear();
  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch {
      // best-effort cleanup
    }
  }
  redisClient = undefined;
  redisDownLogged = false;
}
