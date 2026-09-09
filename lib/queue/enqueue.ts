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
