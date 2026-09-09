/**
 * POSPLUS background worker (SPEC.md §3/§10/§24) — standalone process,
 * deployable separately from the web app (e.g. its own Railway service):
 *
 *   pnpm worker
 *
 * One BullMQ Worker per queue, all eight from SPEC.md §10. Job lifecycles
 * are logged with correlation ids; durations, attempts, and failures are
 * emitted per §24. Graceful shutdown drains in-flight jobs on SIGINT/SIGTERM.
 */
import { UnrecoverableError, Worker, type Job } from "bullmq";

import { redisConnectionOpts } from "@/lib/queue/config";
import { safeJobErrorMessage } from "@/lib/queue/errors";
import { QUEUE_NAMES, type QueueName } from "@/lib/queue/queues";
import { jobLog } from "@/worker/log";
import { resolveProcessor } from "@/worker/registry";

const CONCURRENCY: Record<QueueName, number> = {
  "loyverse-webhooks": 5,
  "loyverse-sync": 2,
  "finance-posting": 5,
  inventory: 5,
  reorder: 2,
  payroll: 2,
  documents: 3,
  analytics: 3,
};

async function processJob(queue: QueueName, job: Job): Promise<unknown> {
  jobLog(String(job.id), "job started", {
    queue,
    name: job.name,
    attempt: job.attemptsMade + 1,
  });
  return resolveProcessor(job.name)(job);
}

async function main(): Promise<void> {
  const opts = redisConnectionOpts();
  jobLog("worker", "starting", {
    queues: QUEUE_NAMES.length,
    redis: `${opts.host}:${opts.port}`,
  });

  const workers: Worker[] = QUEUE_NAMES.map(
    (queue) =>
      new Worker(
        queue,
        (job) => processJob(queue, job),
        { connection: redisConnectionOpts(), concurrency: CONCURRENCY[queue] },
      ),
  );

  for (const worker of workers) {
    const queue = worker.name as QueueName;
    worker.on("completed", (job) => {
      const durationMs =
        job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null;
      jobLog(String(job.id), "job completed", { queue, durationMs });
    });
    worker.on("failed", (job, error) => {
      if (!job) return;
      // UnrecoverableError dead-letters immediately; anything else retries
      // until the configured attempts run out.
      const permanent = error instanceof UnrecoverableError;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      jobLog(String(job.id), "job failed", {
        queue,
        reason: safeJobErrorMessage(error),
        attemptsMade: job.attemptsMade,
        deadLettered: permanent || exhausted,
      });
    });
  }

  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    jobLog("worker", `received ${signal}, draining`, {});
    await Promise.all(workers.map((w) => w.close()));
    jobLog("worker", "stopped", {});
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  jobLog("worker", "fatal startup error", {
    reason: safeJobErrorMessage(error),
  });
  process.exit(1);
});
