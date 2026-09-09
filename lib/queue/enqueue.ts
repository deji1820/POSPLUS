/**
 * Web → worker handoff (SPEC.md §9: never run syncs inside an HTTP request;
 * enqueue a BullMQ job instead).
 *
 * Enqueueing is part of the same unit of work as recording the QUEUED
 * SyncRun: if Redis is unreachable the caller marks the run FAILED with a
 * safe summary and surfaces §19 `QUEUE_UNAVAILABLE` rather than leaving a
 * run that nothing will ever consume.
 */
import { getQueue, JOB_QUEUES, type JobName } from "@/lib/queue/queues";

export class QueueUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The background job queue is unavailable.", options);
    this.name = "QueueUnavailableError";
  }
}

export interface LoyverseSyncJobData {
  syncRunId: string;
  organizationId: string;
}

export interface LoyverseWebhookJobData {
  webhookEventId: string;
  organizationId: string;
  eventType: string;
  /** The verified payload — WebhookEvent stores only metadata + hash (§8). */
  payload: Record<string, unknown>;
}

export interface PostReceiptJobData {
  receiptId: string;
  organizationId: string;
}

export interface PostRefundJobData {
  refundId: string;
  organizationId: string;
}

/** Inventory projection job (#16): apply one receipt/refund's lines as movements. */
export interface ApplyInventoryJobData {
  kind: "receipt" | "refund";
  sourceId: string;
  organizationId: string;
}

/** Outbound stock write-back job (#16): deliver one StockWritebackRequest. */
export interface StockWritebackJobData {
  stockWritebackRequestId: string;
  organizationId: string;
}

function jobNameForRun(type: string): JobName {
  return type === "INITIAL" ? "initial-loyverse-sync" : "incremental-loyverse-sync";
}

/**
 * Enqueue the worker job for a QUEUED SyncRun. `jobId` is derived from the
 * run id so a retried enqueue cannot schedule the same run twice.
 */
export async function enqueueLoyverseSync(input: {
  syncRunId: string;
  organizationId: string;
  type: string;
}): Promise<void> {
  const jobName = jobNameForRun(input.type);
  const queue = getQueue(JOB_QUEUES[jobName]);
  try {
    await queue.add(
      jobName,
      {
        syncRunId: input.syncRunId,
        organizationId: input.organizationId,
      } satisfies LoyverseSyncJobData,
      { jobId: `sync-${input.syncRunId}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}

/**
 * Enqueue a verified webhook event for worker normalization (#9). `jobId` is
 * derived from the stored event id so a retried enqueue cannot schedule the
 * same event twice. The payload rides in the job data because the
 * WebhookEvent row is metadata + hash only (SPEC.md §8).
 */
export async function enqueueLoyverseWebhook(input: {
  webhookEventId: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const jobName = "process-loyverse-webhook" as JobName;
  const queue = getQueue(JOB_QUEUES[jobName]);
  try {
    await queue.add(
      jobName,
      {
        webhookEventId: input.webhookEventId,
        organizationId: input.organizationId,
        eventType: input.eventType,
        payload: input.payload,
      } satisfies LoyverseWebhookJobData,
      { jobId: `webhook-${input.webhookEventId}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}

/**
 * Enqueue a receipt → ledger posting (SPEC.md §11, #11). `jobId` derives from
 * the local receipt id so a retried enqueue (webhook redelivery, sync resume)
 * cannot schedule the same posting twice — the posting itself is idempotent
 * too (partial unique index on the source link).
 */
export async function enqueueReceiptPosting(input: PostReceiptJobData): Promise<void> {
  const queue = getQueue(JOB_QUEUES["post-receipt-to-ledger"]);
  try {
    await queue.add(
      "post-receipt-to-ledger",
      input satisfies PostReceiptJobData,
      { jobId: `post-receipt-${input.receiptId}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}

/** Enqueue a refund → ledger reversal posting (SPEC.md §11, #11). */
export async function enqueueRefundPosting(input: PostRefundJobData): Promise<void> {
  const queue = getQueue(JOB_QUEUES["post-refund-to-ledger"]);
  try {
    await queue.add(
      "post-refund-to-ledger",
      input satisfies PostRefundJobData,
      { jobId: `post-refund-${input.refundId}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}

/**
 * Enqueue the inventory projection for one receipt/refund (#16, SPEC.md §9
 * side effects — the webhook processor schedules it after the event is
 * PROCESSED, mirroring the finance-posting handoff). The projection is
 * idempotent per line (`applyMovement` dedupe keys); `jobId` derives from the
 * source id so a re-enqueue after a queue blip cannot schedule it twice.
 */
export async function enqueueInventoryApply(input: ApplyInventoryJobData): Promise<void> {
  const jobName = (input.kind === "receipt" ? "apply-inventory-for-receipt" : "apply-inventory-for-refund") as JobName;
  const queue = getQueue(JOB_QUEUES[jobName]);
  try {
    await queue.add(
      jobName,
      input satisfies ApplyInventoryJobData,
      { jobId: `inv-${input.kind}-${input.sourceId}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}
