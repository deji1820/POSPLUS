/**
 * WebhookEvent lifecycle processor for the `loyverse-webhooks` queue
 * (SPEC.md §9, issue #9).
 *
 * Owns the WebhookEvent RECEIVED → PROCESSED/IGNORED/FAILED state machine so
 * the web layer only ever stores verified events and enqueues. Per event:
 *   1. cross-tenant check — the job's organizationId must match the stored
 *      event's; a mismatch is a permanent dead-letter (never process an event
 *      into the wrong tenant).
 *   2. dispatch — single-record idempotent upserts via the shared records
 *      mapping (lib/loyverse/webhook/handlers.ts).
 *   3. side effects — receipts/refunds enqueue finance-posting jobs (#11,
 *      SPEC.md §9 "update the local read model and enqueue finance posting").
 *      This runs AFTER the event is marked PROCESSED and outside the dispatch
 *      catch: a queue blip rethrows for a BullMQ retry (the redispatch is
 *      idempotent and the deterministic jobIds dedupe re-enqueues) instead of
 *      flipping an already-processed event to FAILED.
 *   4. audit — one AuditLog row per event with sanitized metadata only
 *      (event id/type, counts, note) — never the payload (§24).
 *
 * Error taxonomy (§19): expected permanent conditions (event vanished,
 * cross-tenant mismatch, receipt with an unsynced store) are recorded on the
 * event AND completed via UnrecoverableError so they don't dead-letter by
 * default; unexpected errors are recorded and rethrown so BullMQ retries.
 */
import type { Job } from "bullmq";

import { prisma } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/loyverse/webhook/handlers";
import {
  enqueueReceiptPosting,
  enqueueRefundPosting,
  type LoyverseWebhookJobData,
} from "@/lib/queue/enqueue";
import {
  isTransient,
  safeJobErrorMessage,
  UnrecoverableError,
} from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

export async function processLoyverseWebhookJob(
  job: Job<LoyverseWebhookJobData>,
): Promise<void> {
  const { webhookEventId, organizationId, eventType, payload } = job.data;

  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) {
    // The immutable event record is the source of truth; without it there is
    // nothing to mark and no idempotency key to protect.
    throw new UnrecoverableError(`Webhook event ${webhookEventId} was not found.`);
  }
  if (event.organizationId !== organizationId || event.eventType !== eventType) {
    throw new UnrecoverableError("Webhook event job data does not match the stored event.");
  }

  const mark = (
    status: "PROCESSED" | "IGNORED" | "FAILED",
    error: string | null,
  ) =>
    prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status, error, processedAt: new Date() },
    });

  const audit = (
    action: "webhook.processed" | "webhook.ignored" | "webhook.failed",
    metadata: Record<string, unknown>,
  ) =>
    prisma.auditLog.create({
      data: {
        organizationId: event.organizationId,
        action,
        entityType: "WebhookEvent",
        entityId: event.id,
        metadataJson: {
          externalEventId: event.externalEventId,
          eventType: event.eventType,
          ...metadata,
        },
      },
    });

  let postingTargets: { receiptIds: string[]; refundIds: string[] } | null = null;
  try {
    const result = await dispatchWebhookEvent({ organizationId, eventType, payload });
    if (result.status === "IGNORED") {
      await mark("IGNORED", null);
      await audit("webhook.ignored", {
        resource: result.resource,
        note: result.note ?? null,
      });
      jobLog(job.id ?? webhookEventId, "webhook ignored", {
        eventId: event.id,
        eventType,
        resource: result.resource,
      });
      return;
    }
    await mark("PROCESSED", null);
    await audit("webhook.processed", {
      resource: result.resource,
      records: result.records,
      refunds: result.refunds,
    });
    jobLog(job.id ?? webhookEventId, "webhook processed", {
      eventId: event.id,
      eventType,
      resource: result.resource,
      records: result.records,
      refunds: result.refunds,
    });
    postingTargets = { receiptIds: result.receiptIds, refundIds: result.refundIds };
  } catch (error) {
    const safe = safeJobErrorMessage(error);
    await mark("FAILED", safe);
    await audit("webhook.failed", { error: safe });
    jobLog(job.id ?? webhookEventId, "webhook failed", {
      eventId: event.id,
      eventType,
      error: safe,
    });
    if (isTransient(error)) throw error;
    throw new UnrecoverableError(safe);
  }

  // §9 side effect: schedule ledger posting for the receipts/refunds this
  // event wrote. Deliberately OUTSIDE the catch above: a queue blip rethrows
  // for a BullMQ retry (the redispatch is idempotent and the deterministic
  // jobIds dedupe the re-enqueue) instead of flipping an already-PROCESSED
  // event to FAILED.
  if (postingTargets) {
    for (const receiptId of postingTargets.receiptIds) {
      await enqueueReceiptPosting({ receiptId, organizationId: event.organizationId });
    }
    for (const refundId of postingTargets.refundIds) {
      await enqueueRefundPosting({ refundId, organizationId: event.organizationId });
    }
    if (
      postingTargets.receiptIds.length > 0 ||
      postingTargets.refundIds.length > 0
    ) {
      jobLog(job.id ?? webhookEventId, "finance posting scheduled", {
        eventId: event.id,
        receipts: postingTargets.receiptIds.length,
        refunds: postingTargets.refundIds.length,
      });
    }
  }
}
