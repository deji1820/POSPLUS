/**
 * SyncRun lifecycle processor for the `loyverse-sync` queue (SPEC.md §9).
 *
 * Owns the QUEUED → RUNNING → COMPLETED/FAILED state machine on SyncRun so
 * the web layer only ever records QUEUED runs and enqueues. The sync engine
 * (#7, lib/loyverse/sync/engine.ts) is injectable for tests; the default runs
 * the real ordered, resumable Loyverse sync. Transient engine errors are
 * recorded on the run AND rethrown so BullMQ retries with backoff (§19) and
 * the retried job resumes from the persisted checkpoint.
 */
import type { Prisma, SyncRun } from "@prisma/client";
import type { Job } from "bullmq";

import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { runLoyverseSync } from "@/lib/loyverse/sync/engine";
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

export const defaultSyncEngine: SyncEngine = (run) => runLoyverseSync(run);

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
  // §17: one audit row per state transition. Runs are system-driven, so the
  // actor is null and metadata carries the sanitized progress signal (counts,
  // safe error summary — never the raw engine error).
  const audit = (
    action:
      | typeof AUDIT_ACTIONS.SYNC.STARTED
      | typeof AUDIT_ACTIONS.SYNC.COMPLETED
      | typeof AUDIT_ACTIONS.SYNC.FAILED,
    metadata: Prisma.InputJsonValue,
  ) =>
    writeAudit({
      organizationId: run.organizationId,
      action,
      entityType: "SyncRun",
      entityId: run.id,
      metadataJson: metadata,
    });
  await audit(AUDIT_ACTIONS.SYNC.STARTED, { type: run.type });

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
    await audit(AUDIT_ACTIONS.SYNC.COMPLETED, { counts: result.counts });
  } catch (error) {
    // The safe reason is preserved on the run (operator-facing) regardless
    // of whether BullMQ will retry it.
    const safeSummary = safeJobErrorMessage(error);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorSummary: safeSummary,
      },
    });
    await audit(AUDIT_ACTIONS.SYNC.FAILED, {
      errorSummary: safeSummary,
      willRetry: isTransient(error),
    });
    // Permanent failures are fully recorded above — the job itself completes
    // so operator-correctable failures don't dead-letter by default.
    if (isTransient(error)) throw error;
  }
}
