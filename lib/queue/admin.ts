/**
 * Dead-letter inspection and retry controls for authorized admins
 * (SPEC.md §19 "expose retry controls to authorized admins").
 *
 * The HTTP routes under app/api/jobs/ are thin wrappers over these functions
 * (SETTINGS-gated, i.e. Owner-only per the §5 matrix) so the logic stays
 * unit-testable without standing up BullMQ.
 */
import { getQueue, isQueueName, type QueueName } from "@/lib/queue/queues";

export interface FailedJobSummary {
  id: string;
  name: string;
  queue: QueueName;
  attemptsMade: number;
  /** Operator-safe failure reason (§19 — never a stack trace). */
  failedReason: string | null;
  finishedOn: number | null;
}

export class UnknownQueueError extends Error {
  constructor(readonly queue: string) {
    super(`Unknown queue: ${queue}`);
    this.name = "UnknownQueueError";
  }
}

export async function listFailedJobs(
  queueName: string,
  max = 50,
): Promise<FailedJobSummary[]> {
  if (!isQueueName(queueName)) throw new UnknownQueueError(queueName);
  const queue = getQueue(queueName);
  const jobs = await queue.getFailed(0, Math.max(0, max - 1));
  return jobs.map((job) => ({
    id: String(job.id),
    name: job.name,
    queue: queueName as QueueName,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason ?? null,
    finishedOn: job.finishedOn ?? null,
  }));
}

export async function retryFailedJob(
  queueName: string,
  jobId: string,
): Promise<boolean> {
  if (!isQueueName(queueName)) throw new UnknownQueueError(queueName);
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);
  if (!job) return false;
  await job.retry();
  return true;
}
