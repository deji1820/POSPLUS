/**
 * POST /api/loyverse/webhook — SPEC.md §9 webhook flow, §18 webhook security.
 *
 * Public machine-to-machine endpoint (no session auth — the signature IS the
 * authentication):
 *   verify signature (before parsing) → validate schema + event identity →
 *   store immutable WebhookEvent → enqueue BullMQ job → return quickly.
 *
 * Security properties:
 *   - signature mismatch → 401, body never parsed for business data
 *   - replay of an already-stored event → 200 idempotent ack, no re-enqueue
 *     (event identity is the SHA-256 of the raw body; unique per org)
 *   - tenant attribution comes from the merchant/store mapping, never from
 *     trusting an org id in the body (§18)
 *   - bodies are never logged — event id, type, and hash only (§24)
 *   - rate-limited per source IP (§22)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { apiError, ok } from "@/lib/api/envelope";
import { apiRoute } from "@/lib/api/handler";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { prisma } from "@/lib/db";
import { enqueueLoyverseWebhook, QueueUnavailableError } from "@/lib/queue/enqueue";
import {
  externalEventId,
  payloadHash,
  verifyLoyverseWebhook,
  WebhookSecretMissingError,
} from "@/lib/loyverse/webhook/verify";
import { resolveWebhookOrganization } from "@/lib/loyverse/webhook/resolve-org";
import { jobLog } from "@/worker/log";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 256 * 1024;

/** Minimal schema — event identity fields only; resources pass through. */
const webhookPayloadSchema = z.object({
  merchant_id: z.string().min(1),
  type: z.string().min(1).max(200),
  created_at: z.string().min(1),
});

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export const POST = apiRoute(handler);

async function handler(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const userAgent = req.headers.get("user-agent");
  if (!(await checkRateLimit(`loyverse-webhook:${ip}`, 60, 60_000))) {
    return NextResponse.json(
      apiError("RATE_LIMITED", "Too many webhook requests. Slow down and retry."),
      { status: 429 },
    );
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      apiError("INVALID_WEBHOOK_PAYLOAD", "Payload too large."),
      { status: 400 },
    );
  }

  // 1 — verify BEFORE parsing (§18). Misconfiguration is a 500, bad
  // signature is a 401; in both cases nothing is stored.
  let verified: boolean;
  try {
    verified = verifyLoyverseWebhook({
      rawBody,
      signature: req.headers.get("x-loyverse-signature") ?? undefined,
      authorization: req.headers.get("authorization") ?? undefined,
      secret: process.env.LOYVERSE_WEBHOOK_SECRET,
    });
  } catch (error) {
    if (error instanceof WebhookSecretMissingError) {
      jobLog("webhook", "webhook rejected: secret not configured", { ip });
      return NextResponse.json(
        apiError("WEBHOOK_NOT_CONFIGURED", "Webhook verification is not configured."),
        { status: 500 },
      );
    }
    throw error;
  }
  if (!verified) {
    jobLog("webhook", "webhook rejected: invalid signature", { ip });
    // §17 security audit: a rejected verification is recorded against the
    // would-be organization when the merchant maps to one of ours. This is
    // for security visibility only — the event is NOT attributed for
    // business processing, nothing is stored, and an unresolvable merchant
    // simply gets no row (organizationId is required on AuditLog).
    let rejectedOrg: string | null = null;
    let rejectedEventType: string | null = null;
    try {
      const parsedBody: unknown = JSON.parse(rawBody);
      if (
        typeof parsedBody === "object" && parsedBody !== null &&
        typeof (parsedBody as { type?: unknown }).type === "string"
      ) {
        rejectedEventType = (parsedBody as { type: string }).type;
      }
      rejectedOrg = await resolveWebhookOrganization(parsedBody as Record<string, unknown>);
    } catch {
      // Unparseable body: no merchant to resolve — nothing to audit against.
    }
    if (rejectedOrg) {
      await writeAudit({
        organizationId: rejectedOrg,
        action: AUDIT_ACTIONS.WEBHOOK.VERIFICATION_FAILED,
        entityType: "WebhookEvent",
        entityId: externalEventId(rawBody),
        metadataJson: { reason: "invalid_signature", eventType: rejectedEventType },
        ipAddress: ip,
        userAgent,
      });
    }
    return NextResponse.json(
      apiError("INVALID_WEBHOOK_SIGNATURE", "Signature verification failed."),
      { status: 401 },
    );
  }

  // 2 — parse + validate the envelope.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      apiError("INVALID_WEBHOOK_PAYLOAD", "Body is not valid JSON."),
      { status: 400 },
    );
  }
  const parsed = webhookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      apiError(
        "INVALID_WEBHOOK_PAYLOAD",
        "Payload must include merchant_id, type, and created_at.",
      ),
      { status: 400 },
    );
  }

  // 3 — attribute the event to an organization. Attribute from the FULL
  // parsed payload, not zod's stripped envelope: store attribution needs the
  // store_id fields the envelope schema does not retain. The body is signature
  // verified at this point, and store/merchant ids are matched against OUR
  // synced rows — a bogus id simply matches nothing (§18).
  const organizationId = await resolveWebhookOrganization(payload as Record<string, unknown>);
  if (!organizationId) {
    // Not a business we serve: ack so Loyverse does not retry forever, drop
    // (no org to attach the immutable event to). Sanitized log only (§24).
    jobLog("webhook", "webhook dropped: unknown business", {
      eventType: parsed.data.type,
      merchantId: parsed.data.merchant_id,
    });
    return NextResponse.json(ok({ received: true, routed: false }), { status: 200 });
  }

  // 4 — store the immutable event. Identity = payload hash, so an exact
  // replay collides on the unique (organizationId, externalEventId) pair and
  // is acked without re-enqueueing.
  const eventId = externalEventId(rawBody);
  let event;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        organizationId,
        externalEventId: eventId,
        eventType: parsed.data.type,
        signatureVerified: true,
        payloadHash: payloadHash(rawBody),
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      jobLog("webhook", "webhook replay ignored", {
        eventType: parsed.data.type,
        externalEventId: eventId,
      });
      // §17: a replay is a webhook rejection the operator can query — the
      // colliding identity is the before-state, the idempotent ack the after.
      await writeAudit({
        organizationId,
        action: AUDIT_ACTIONS.WEBHOOK.DUPLICATE,
        entityType: "WebhookEvent",
        entityId: eventId,
        beforeJson: { externalEventId: eventId, eventType: parsed.data.type },
        afterJson: { received: true, duplicate: true },
        ipAddress: ip,
        userAgent,
      });
      return NextResponse.json(ok({ received: true, duplicate: true }), { status: 200 });
    }
    throw error;
  }

  // 5 — hand off to the worker and return quickly. The FULL verified payload
  // rides in the job data (zod's parsed.data is stripped to schema fields).
  try {
    await enqueueLoyverseWebhook({
      webhookEventId: event.id,
      organizationId,
      eventType: parsed.data.type,
      payload: payload as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: "FAILED",
          error: "Could not schedule webhook processing: job queue unavailable.",
          processedAt: new Date(),
        },
      });
      await writeAudit({
        organizationId,
        action: AUDIT_ACTIONS.WEBHOOK.ENQUEUE_FAILED,
        entityType: "WebhookEvent",
        entityId: event.id,
        afterJson: { received: true, enqueued: false },
        metadataJson: { eventType: parsed.data.type, externalEventId: eventId },
        ipAddress: ip,
        userAgent,
      });
      return NextResponse.json(
        apiError("QUEUE_UNAVAILABLE", "The background job queue is unavailable. The event is retained and can be retried."),
        { status: 503 },
      );
    }
    throw error;
  }

  jobLog("webhook", "webhook accepted", {
    eventId: event.id,
    eventType: parsed.data.type,
    organizationId,
  });
  // §17: the acceptance row — identity + request context, no payload (§24).
  await writeAudit({
    organizationId,
    action: AUDIT_ACTIONS.WEBHOOK.ACCEPTED,
    entityType: "WebhookEvent",
    entityId: event.id,
    afterJson: { eventType: parsed.data.type, externalEventId: eventId },
    ipAddress: ip,
    userAgent,
  });
  return NextResponse.json(ok({ received: true, eventId: event.id }), { status: 202 });
}
