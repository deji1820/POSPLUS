/**
 * Nightly maintenance processors (SPEC.md §10, issue #33).
 *
 * The three processors with real inputs today. All three are org-scanning
 * (no org id in the job data) and idempotent by construction, so a BullMQ
 * retry is a no-op sweep. Findings are audit rows (lib/audit) and the job
 * result, never job failures — a reconciliation mismatch or a stale run is
 * operator data, not a broken job. Infra errors (DB down) rethrow and retry.
 */
import type { Job } from "bullmq";

import { runReconciliationChecks } from "@/lib/maintenance/reconciliation";
import { recalculateReorderPoints } from "@/lib/maintenance/reorder";
import { runStaleChecks } from "@/lib/maintenance/stale-checks";
import { safeJobErrorMessage } from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

export async function processRecalculateReorderPointsJob(job: Job): Promise<unknown> {
  const logId = job.id ?? "recalculate-reorder-points";
  try {
    const summary = await recalculateReorderPoints();
    jobLog(logId, "reorder points recalculated", { ...summary });
    return summary;
  } catch (error) {
    jobLog(logId, "reorder recalculation failed", {
      error: safeJobErrorMessage(error),
    });
    throw error;
  }
}

export async function processStaleWebhookSyncCheckJob(job: Job): Promise<unknown> {
  const logId = job.id ?? "stale-webhook-sync-check";
  try {
    const summary = await runStaleChecks();
    jobLog(logId, "stale integration sweep completed", { ...summary });
    return summary;
  } catch (error) {
    jobLog(logId, "stale integration sweep failed", {
      error: safeJobErrorMessage(error),
    });
    throw error;
  }
}

export async function processReconciliationCheckJob(job: Job): Promise<unknown> {
  const logId = job.id ?? "reconciliation-check";
  try {
    const summary = await runReconciliationChecks();
    jobLog(logId, "reconciliation checks completed", { ...summary });
    return summary;
  } catch (error) {
    jobLog(logId, "reconciliation checks failed", {
      error: safeJobErrorMessage(error),
    });
    throw error;
  }
}
