/**
 * Loyverse webhook verification (SPEC.md §9 webhook flow, §18 webhook
 * security). Official mechanism per Loyverse Developer Docs: webhooks created
 * by an OAuth2 application carry an `X-Loyverse-Signature` header — lowercase
 * hex HMAC-SHA1 of the raw request body keyed with the app's client secret.
 * Verification happens BEFORE parsing: an unverified body is never inspected
 * for business data (§18 "never trust tenant identifiers from an
 * unauthenticated body").
 *
 * A shared-secret fallback (`Authorization: Bearer <LOYVERSE_WEBHOOK_SECRET>`)
 * supports providers/stubs that cannot sign; both paths compare in constant
 * time. The secret is compared, never logged.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Webhook secret not configured — fail closed rather than accept unsigned. */
export class WebhookSecretMissingError extends Error {
  constructor() {
    super("LOYVERSE_WEBHOOK_SECRET is not configured.");
    this.name = "WebhookSecretMissingError";
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface VerifyWebhookInput {
  /** Exact raw request body — signature is computed over these bytes. */
  rawBody: string;
  signature?: string | undefined;
  authorization?: string | undefined;
  secret?: string | undefined;
}

/**
 * Returns true when the request authenticates against the shared secret.
 * Throws WebhookSecretMissingError when no secret is configured (the route
 * surfaces that as a 500 misconfiguration, not a silent pass).
 */
export function verifyLoyverseWebhook(input: VerifyWebhookInput): boolean {
  const secret = input.secret?.trim();
  if (!secret) throw new WebhookSecretMissingError();

  if (input.signature) {
    const expected = createHmac("sha1", secret).update(input.rawBody, "utf8").digest("hex");
    // Lowercase hex comparison — length check first so timingSafeEqual never
    // receives unequal-length buffers.
    return expected.length === input.signature.length && safeEqual(expected, input.signature);
  }

  // Fallback: bearer shared-secret (e.g. PAT-created webhooks carry no
  // signature header at all per Loyverse docs).
  if (input.authorization) {
    return safeEqual(input.authorization, `Bearer ${secret}`);
  }

  return false;
}

/** SHA-256 of the raw body — the immutable-event payload hash + idempotency key base (§18 "store a hash / event ID"). */
export function payloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Loyverse sends no per-event id, so the event identity IS the payload hash:
 * a retried delivery of the same body dedupes on the unique
 * (organizationId, externalEventId) pair — exact replays are idempotent.
 */
export function externalEventId(rawBody: string): string {
  return `sha256:${payloadHash(rawBody)}`;
}
