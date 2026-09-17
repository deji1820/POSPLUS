/**
 * Nightly maintenance job manifest (SPEC.md §10 "Run nightly", issue #33).
 *
 * The scheduler fires exactly these eight jobs every night. Five of them have
 * real processors today (reorder recalculation, reconciliation checks,
 * stale webhook/sync failure checks — plus calculate-payroll / document
 * generation which are triggered by their own domains, not by this list);
 * the analytics jobs whose domain logic lands in later issues stay
 * permanent not-implemented stubs in the worker registry: they are still
 * fired nightly, dead-letter with an operator-safe reason, and are recorded
 * in the queue's failed set rather than silently dropped.
 *
 * `enqueueNightlyJobs` is the single enqueue path shared by the worker
 * scheduler and any operator-triggered "run now" surface. Job ids embed the
 * fire id so a retried enqueue for the same fire cannot schedule duplicates.
 */
import { getQueue, JOB_QUEUES, type JobName } from "@/lib/queue/queues";

/** The eight nightly items from SPEC.md §10, in firing order. */
export const NIGHTLY_JOBS = [
  { name: "recalculate-reorder-points", summary: "reorder-point recalculation" },
  { name: "reconciliation-check", summary: "reconciliation checks" },
  { name: "stale-webhook-sync-check", summary: "stale webhook/sync failure checks" },
  { name: "generate-recurring-report", summary: "recurring reports" },
  { name: "supplier-scorecard-refresh", summary: "supplier scorecard snapshots" },
  { name: "refresh-dashboard-metric-snapshots", summary: "dashboard aggregate refresh" },
  { name: "refresh-ingredient-price-trends", summary: "supplier ingredient price trend refresh" },
  { name: "detect-price-change-alerts", summary: "price-change alert detection/re-evaluation" },
] as const satisfies ReadonlyArray<{ name: JobName; summary: string }>;

export type NightlyJobName = (typeof NIGHTLY_JOBS)[number]["name"];

export interface NightlyEnqueueResult {
  fireId: string;
  enqueued: NightlyJobName[];
  /** Per-job enqueue failures (e.g. Redis unreachable) — safe messages only. */
  failures: Array<{ name: NightlyJobName; error: string }>;
}

/** One deduplicated fire id per scheduler tick. */
export function fireIdFor(now: Date = new Date()): string {
  return `nightly-${Math.floor(now.getTime() / 1000)}`;
}

/**
 * Enqueue every nightly job for one fire. Individual enqueue failures are
 * collected (and reported by the caller) instead of aborting the batch, so
 * one unreachable queue cannot block the other seven jobs.
 */
export async function enqueueNightlyJobs(fireId: string): Promise<NightlyEnqueueResult> {
  const result: NightlyEnqueueResult = { fireId, enqueued: [], failures: [] };
  for (const { name } of NIGHTLY_JOBS) {
    const queue = getQueue(JOB_QUEUES[name]);
    try {
      await queue.add(name, { fireId }, { jobId: `${name}-${fireId}` });
      result.enqueued.push(name);
    } catch (error) {
      result.failures.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
