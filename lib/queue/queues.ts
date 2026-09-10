/**
 * Queue and job registry per SPEC.md §10.
 *
 * All eight queues exist from this issue on; processors for job types whose
 * domain logic lands in later issues are permanent-failure stubs that
 * dead-letter immediately with a safe operator-facing reason (§19), so a
 * mis-routed job is recorded, not silently dropped.
 *
 * Queue instances are created lazily so importing this module from a route
 * handler or the worker entry never opens a Redis connection by itself.
 */
import { Queue, type JobsOptions } from "bullmq";

import { redisConnectionOpts } from "@/lib/queue/config";

export const QUEUE_NAMES = [
  "loyverse-webhooks",
  "loyverse-sync",
  "finance-posting",
  "inventory",
  "reorder",
  "payroll",
  "documents",
  "analytics",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** SPEC.md §10 job list → owning queue. */
export const JOB_QUEUES = {
  "process-loyverse-webhook": "loyverse-webhooks",
  "initial-loyverse-sync": "loyverse-sync",
  "incremental-loyverse-sync": "loyverse-sync",
  "post-receipt-to-ledger": "finance-posting",
  "post-refund-to-ledger": "finance-posting",
  // `inventory` queue (#16): projection jobs for webhook receipts/refunds and
  // outbound stock write-backs.
  "apply-inventory-for-receipt": "inventory",
  "apply-inventory-for-refund": "inventory",
  "write-back-stock": "inventory",
  "recalculate-reorder-points": "reorder",
  "calculate-payroll": "payroll",
  "generate-po-pdf": "documents",
  "generate-payslip-pdf": "documents",
  "generate-pnl-pdf": "documents",
  "generate-recurring-report": "analytics",
  "supplier-scorecard-refresh": "analytics",
  "refresh-dashboard-metric-snapshots": "analytics",
  "detect-price-change-alerts": "analytics",
  "refresh-supplier-price-recommendations": "analytics",
  "refresh-ingredient-price-trends": "analytics",
} as const satisfies Record<string, QueueName>;

export type JobName = keyof typeof JOB_QUEUES;

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * §19 retry policy: transient failures retry with exponential backoff; after
 * the final attempt the job lands in the queue's failed set (the dead-letter
 * path) where operators can inspect and retry it via the jobs API.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: redisConnectionOpts(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/** Test/shutdown helper: close every queue created so far. */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
