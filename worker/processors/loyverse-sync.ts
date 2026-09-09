/**
 * SyncRun lifecycle processor for the `loyverse-sync` queue (SPEC.md §9).
 *
 * Owns the QUEUED → RUNNING → COMPLETED/FAILED state machine on SyncRun so
 * the web layer only ever records QUEUED runs and enqueues. The actual sync
 * engine is injectable: #6 ships a permanent "not available yet" stub that
 * records a safe FAILED summary on the run (#7 replaces it with the real
 * initial/incremental implementation), while transient engine errors are
 * recorded on the run AND rethrown so BullMQ retries with backoff (§19).
 */
import type { SyncRun } from "@prisma/client";
import type { Job } from "bullmq";

import { prisma } from "@/lib/db";
import {
  isTransient,
  safeJobErrorMessage,
  UnrecoverableError,
} from "@/lib/queue/errors";
import type { LoyverseSyncJobData } from "@/lib/queue/enqueue";

export interface SyncEngineResult {
  counts: Record<string, number>;
}

export type SyncEngine = (run: SyncRun) => Promise<SyncEngineResult>;

/** Permanent stub until #7 lands the real sync implementation. */
export class SyncEngineUnavailableError extends UnrecoverableError {
  constructor() {
    super("Sync engine not yet available (initial sync lands with #7).");
    this.name = "SyncEngineUnavailableError";
  }
}

export const defaultSyncEngine: SyncEngine = async () => {
  throw new SyncEngineUnavailableError();
};

export async function processLoyverseSyncJob(
  job: Job<LoyverseSyncJobData>,
  engine: SyncEngine = defaultSyncEngine,
): Promise<void> {
  const { syncRunId, organizationId } = job.data;

  const run = await prisma.syncRun.findUnique({ where: { id: syncRunId } });
  if (!run) {
    throw new UnrecoverableError(`Sync run ${syncRunId} was not found.`);
  }
  if (run.organizationId !== organizationId) {
    throw new UnrecoverableError("Sync run organization mismatch.");
  }

  // FAILED here also covers a run being retried by an operator: it goes back
  // to RUNNING on each attempt and only its final state sticks.
  await prisma.syncRun.update({
    where: { id: run.id },
    data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, errorSummary: null },
  });

  try {
    const result = await engine(run);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        counts: result.counts,
        errorSummary: null, // clear any summary from a previous failed attempt
      },
    });
  } catch (error) {
    // The safe reason is preserved on the run (operator-facing) regardless
    // of whether BullMQ will retry it.
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorSummary: safeJobErrorMessage(error),
      },
    });
    // Permanent failures (incl. the #7 stub) are fully recorded above — the
    // job itself completes so real syncs don't dead-letter by default.
    if (isTransient(error)) throw error;
  }
}
