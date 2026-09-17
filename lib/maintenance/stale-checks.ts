/**
 * Nightly stale webhook/sync failure checks (SPEC.md §10, issue #33).
 *
 * Flags integration rows that need operator attention and records each
 * finding as an org-scoped audit row (§17) with a system (null) actor:
 *
 *   - SyncRun stuck RUNNING longer than the stall threshold — the worker
 *     crashed mid-run and nothing will ever finish it;
 *   - SyncRun FAILED within the flag window — covers failures injected or
 *     written outside the normal processor path (the processor already
 *     audits its own failures, but the nightly sweep is the backstop that
 *     guarantees every FAILED run is visible);
 *   - WebhookEvent still RECEIVED past the dispatch threshold — accepted
 *     but never enqueued/dispatched (e.g. enqueue outage at accept time);
 *   - WebhookEvent FAILED within the flag window — dispatch or processing
 *     failed and may need a manual retry.
 *
 * Flagging is idempotent-by-append: the audit log is a history, so a run
 * that stays failed is flagged again on subsequent nights until fixed —
 * exactly what an operator sweep should do.
 */
import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { prisma } from "@/lib/db";

/** A run RUNNING longer than this is considered stuck (worker crash). */
export const STUCK_RUN_THRESHOLD_MS = 2 * 3600 * 1000;
/** FAILED runs/webhooks from the last window are flagged each night. */
export const FAILED_FLAG_WINDOW_MS = 24 * 3600 * 1000;
/** A webhook accepted but not dispatched within this needs attention. */
export const UNDISPATCHED_WEBHOOK_THRESHOLD_MS = 30 * 60 * 1000;

export interface StaleCheckSummary {
  organizations: number;
  stuckRuns: number;
  failedRuns: number;
  undispatchedWebhooks: number;
  failedWebhooks: number;
}

function ageMs(from: Date, now: Date): number {
  return now.getTime() - from.getTime();
}

async function checkOrganization(
  organizationId: string,
  now: Date,
  summary: StaleCheckSummary,
): Promise<void> {
  const stuckBefore = new Date(now.getTime() - STUCK_RUN_THRESHOLD_MS);
  const failedSince = new Date(now.getTime() - FAILED_FLAG_WINDOW_MS);
  const webhookStaleBefore = new Date(now.getTime() - UNDISPATCHED_WEBHOOK_THRESHOLD_MS);

  const stuckRuns = await prisma.syncRun.findMany({
    where: { organizationId, status: "RUNNING", startedAt: { lt: stuckBefore } },
    select: { id: true, type: true, startedAt: true },
  });
  for (const run of stuckRuns) {
    await writeAudit({
      organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.MAINTENANCE.STALE_SYNC_RUN,
      entityType: "SyncRun",
      entityId: run.id,
      metadataJson: {
        reason: "stuck_running",
        type: run.type,
        startedAt: run.startedAt.toISOString(),
        ageMs: ageMs(run.startedAt, now),
      },
    });
    summary.stuckRuns += 1;
  }

  const failedRuns = await prisma.syncRun.findMany({
    where: {
      organizationId,
      status: "FAILED",
      OR: [{ finishedAt: { gte: failedSince } }, { finishedAt: null }],
    },
    select: { id: true, type: true, errorSummary: true, startedAt: true, finishedAt: true },
  });
  for (const run of failedRuns) {
    await writeAudit({
      organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.MAINTENANCE.STALE_SYNC_RUN,
      entityType: "SyncRun",
      entityId: run.id,
      metadataJson: {
        reason: "failed",
        type: run.type,
        errorSummary: run.errorSummary,
        startedAt: run.startedAt.toISOString(),
      },
    });
    summary.failedRuns += 1;
  }

  const undispatched = await prisma.webhookEvent.findMany({
    where: {
      organizationId,
      status: "RECEIVED",
      processedAt: null,
      receivedAt: { lt: webhookStaleBefore },
    },
    select: { id: true, eventType: true, receivedAt: true },
  });
  for (const event of undispatched) {
    await writeAudit({
      organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.MAINTENANCE.STALE_WEBHOOK,
      entityType: "WebhookEvent",
      entityId: event.id,
      metadataJson: {
        reason: "never_dispatched",
        eventType: event.eventType,
        receivedAt: event.receivedAt.toISOString(),
        ageMs: ageMs(event.receivedAt, now),
      },
    });
    summary.undispatchedWebhooks += 1;
  }

  const failedWebhooks = await prisma.webhookEvent.findMany({
    where: {
      organizationId,
      status: "FAILED",
      OR: [{ processedAt: { gte: failedSince } }, { processedAt: null }],
      receivedAt: { gte: failedSince },
    },
    select: { id: true, eventType: true, error: true, receivedAt: true },
  });
  for (const event of failedWebhooks) {
    await writeAudit({
      organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.MAINTENANCE.STALE_WEBHOOK,
      entityType: "WebhookEvent",
      entityId: event.id,
      metadataJson: {
        reason: "failed",
        eventType: event.eventType,
        error: event.error,
        receivedAt: event.receivedAt.toISOString(),
      },
    });
    summary.failedWebhooks += 1;
  }
}

/** Sweep every organization for stale/failed integration rows. */
export async function runStaleChecks(now: Date = new Date()): Promise<StaleCheckSummary> {
  const summary: StaleCheckSummary = {
    organizations: 0,
    stuckRuns: 0,
    failedRuns: 0,
    undispatchedWebhooks: 0,
    failedWebhooks: 0,
  };
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    summary.organizations += 1;
    await checkOrganization(org.id, now, summary);
  }
  return summary;
}
