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
