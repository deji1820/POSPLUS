/**
 * Nightly scheduler (issue #33, SPEC.md §10).
 *
 * - NIGHTLY_JOBS covers exactly the eight nightly items and every name maps
 *   to a queue in JOB_QUEUES (a manifest drift would mean the scheduler
 *   silently stops firing something);
 * - enqueueNightlyJobs dedupes per fire via job ids and collects per-job
 *   enqueue failures instead of aborting the batch;
 * - nextDailyFire / intervalSeconds encode the dev-compression + nightly-at
 *   schedule arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_QUEUES } from "@/lib/queue/queues";
import {
  NIGHTLY_JOBS,
  enqueueNightlyJobs,
  fireIdFor,
} from "@/lib/scheduler/nightly";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
}));

vi.mock("@/lib/queue/queues", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/queue/queues")>();
  return {
    ...actual,
    getQueue: () => ({ add: mocks.add }),
  };
});

const SCHEDULER_ENV_VARS = ["SCHEDULER_INTERVAL_SECONDS", "NIGHTLY_AT", "SCHEDULER_ENABLED"] as const;

describe("NIGHTLY_JOBS manifest", () => {
  it("covers exactly the eight SPEC.md §10 nightly items", () => {
    expect(NIGHTLY_JOBS).toHaveLength(8);
    expect(NIGHTLY_JOBS.map((j) => j.name)).toEqual([
      "recalculate-reorder-points",
      "reconciliation-check",
      "stale-webhook-sync-check",
      "generate-recurring-report",
      "supplier-scorecard-refresh",
      "refresh-dashboard-metric-snapshots",
      "refresh-ingredient-price-trends",
      "detect-price-change-alerts",
    ]);
  });

  it("every nightly job maps to a queue and has a human summary", () => {
    for (const job of NIGHTLY_JOBS) {
      expect(JOB_QUEUES[job.name], job.name).toBeDefined();
      expect(job.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("enqueueNightlyJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.add.mockResolvedValue(undefined);
  });

  it("enqueues all eight jobs with per-fire dedup job ids", async () => {
    const fireId = fireIdFor(new Date("2026-09-10T02:00:00.000Z"));
    const result = await enqueueNightlyJobs(fireId);

    expect(result.enqueued).toHaveLength(8);
    expect(result.failures).toHaveLength(0);
    expect(mocks.add).toHaveBeenCalledTimes(8);
    for (const { name } of NIGHTLY_JOBS) {
      expect(mocks.add).toHaveBeenCalledWith(
        name,
        { fireId },
        { jobId: `${name}-${fireId}` },
      );
    }
  });

  it("collects per-job failures without aborting the batch", async () => {
    mocks.add.mockRejectedValueOnce(new Error("redis unreachable"));

    const result = await enqueueNightlyJobs("nightly-1");

    expect(result.enqueued).toHaveLength(7);
    expect(result.failures).toEqual([
      { name: "recalculate-reorder-points", error: "redis unreachable" },
    ]);
  });
});

describe("schedule arithmetic", () => {
  afterEach(() => {
    for (const key of SCHEDULER_ENV_VARS) delete process.env[key];
  });

  it("fireIdFor buckets a fire to the second", () => {
    const at = new Date("2026-09-10T02:00:00.500Z");
    expect(fireIdFor(at)).toBe(`nightly-${Math.floor(at.getTime() / 1000)}`);
    expect(fireIdFor()).toMatch(/^nightly-\d+$/);
  });

  it("nextDailyFire returns today when the time is still ahead, else tomorrow", async () => {
    const { nextDailyFire } = await import("@/worker/scheduler");
    const from = new Date("2026-09-10T01:00:00");
    const sameDay = nextDailyFire("02:00", from);
    expect(sameDay.getDate()).toBe(10);
    expect(sameDay.getHours()).toBe(2);
    expect(sameDay.getMinutes()).toBe(0);

    const past = nextDailyFire("01:00", from);
    expect(past.getDate()).toBe(11);
  });

  it("intervalSeconds parses the dev compression override with a floor", async () => {
    const { intervalSeconds } = await import("@/worker/scheduler");
    expect(intervalSeconds()).toBeNull();

    process.env.SCHEDULER_INTERVAL_SECONDS = "30";
    expect(intervalSeconds()).toBe(30);

    process.env.SCHEDULER_INTERVAL_SECONDS = "1";
    expect(intervalSeconds()).toBe(5);

    process.env.SCHEDULER_INTERVAL_SECONDS = "nonsense";
    expect(intervalSeconds()).toBeNull();
  });

  it("schedulerEnabled defaults on and honors false", async () => {
    const { schedulerEnabled } = await import("@/worker/scheduler");
    delete process.env.SCHEDULER_ENABLED;
    expect(schedulerEnabled()).toBe(true);
    process.env.SCHEDULER_ENABLED = "false";
    expect(schedulerEnabled()).toBe(false);
  });
});

describe("acquireOrRenewLock", () => {
  function fakeLock(initial: string | null) {
    const state = { value: initial, pexpireCalls: 0 };
    const client = {
      get: async () => state.value,
      set: async (_k: string, v: string) => {
        if (state.value !== null) return null;
        state.value = v;
        return "OK" as const;
      },
      pexpire: async () => {
        state.pexpireCalls += 1;
        return 1;
      },
    };
    return { state, client };
  }

  it("renews when the same instance already holds the lock", async () => {
    const { acquireOrRenewLock } = await import("@/worker/scheduler");
    const { state, client } = fakeLock("me");
    expect(await acquireOrRenewLock(client, "k", 1000, "me")).toBe(true);
    expect(state.pexpireCalls).toBe(1);
  });

  it("yields to a different holder without touching the lock", async () => {
    const { acquireOrRenewLock } = await import("@/worker/scheduler");
    const { state, client } = fakeLock("other");
    expect(await acquireOrRenewLock(client, "k", 1000, "me")).toBe(false);
    expect(state.pexpireCalls).toBe(0);
    expect(state.value).toBe("other");
  });

  it("acquires a free lock and reports errors as false", async () => {
    const { acquireOrRenewLock } = await import("@/worker/scheduler");
    const { state, client } = fakeLock(null);
    expect(await acquireOrRenewLock(client, "k", 1000, "me")).toBe(true);
    expect(state.value).toBe("me");

    const broken = {
      get: async () => {
        throw new Error("connection refused");
      },
      set: async () => null,
      pexpire: async () => 0,
    };
    expect(await acquireOrRenewLock(broken, "k", 1000, "me")).toBe(false);
  });
});
