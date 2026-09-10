/**
 * Webhook-route audit coverage (SPEC.md §17, issue #15).
 *
 * The acceptance criterion — "a webhook rejection … produce[s] a queryable
 * audit row with actor and before/after JSON" — is exercised here at the
 * route level: a valid event writes webhook.accepted, an exact replay writes
 * webhook.duplicate (a rejection the operator can query, carrying before/after
 * JSON), a bad signature against a known merchant writes
 * webhook.verification_failed with the request's IP, and a queue outage
 * writes webhook.enqueue_failed. An invalid signature from an UNKNOWN
 * merchant writes nothing (organizationId is required on AuditLog — there is
 * no org to attach the row to).
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/loyverse/webhook/route";
import { enqueueLoyverseWebhook, QueueUnavailableError } from "@/lib/queue/enqueue";
import { resolveWebhookOrganization } from "@/lib/loyverse/webhook/resolve-org";
import { checkRateLimit } from "@/lib/auth/rate-limit";

const mocks = vi.hoisted(() => ({
  webhookEventCreate: vi.fn(),
  webhookEventUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEvent: {
      create: mocks.webhookEventCreate,
      update: mocks.webhookEventUpdate,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock("@/lib/queue/enqueue", () => ({
  enqueueLoyverseWebhook: vi.fn(),
  QueueUnavailableError: class QueueUnavailableError extends Error {
    constructor(options?: { cause?: unknown }) {
      super("The background job queue is unavailable.", options);
      this.name = "QueueUnavailableError";
    }
  },
}));

vi.mock("@/lib/loyverse/webhook/resolve-org", () => ({
  resolveWebhookOrganization: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: vi.fn(() => true),
}));

vi.mock("@/worker/log", () => ({ jobLog: vi.fn() }));

const SECRET = "test-webhook-secret";

const RECEIPT_BODY = JSON.stringify({
  merchant_id: "merchant-1",
  type: "receipts.create",
  created_at: "2024-01-15T10:30:45Z",
  receipts: [{ id: "rcpt-1", store_id: "store-1", receipt_number: "R-1", total_money: 10 }],
});

function sign(rawBody: string, secret: string = SECRET): string {
  return createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
}

function webhookRequest(rawBody: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3002/api/loyverse/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  }) as never;
}

function auditRows() {
  return mocks.auditLogCreate.mock.calls.map((c) => c[0].data);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOYVERSE_WEBHOOK_SECRET = SECRET;
  mocks.webhookEventCreate.mockResolvedValue({ id: "evt-1" });
  mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" });
  vi.mocked(resolveWebhookOrganization).mockResolvedValue("org-1");
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(enqueueLoyverseWebhook).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.LOYVERSE_WEBHOOK_SECRET;
});

describe("POST /api/loyverse/webhook — §17 audit rows", () => {
  it("accepted event: writes webhook.accepted with identity + request context", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, {
        "x-loyverse-signature": sign(RECEIPT_BODY),
        "x-forwarded-for": "203.0.113.9",
        "user-agent": "loyverse-hook/1.0",
      }),
    );
    expect(res.status).toBe(202);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "org-1",
      actorUserId: null,
      action: "webhook.accepted",
      entityType: "WebhookEvent",
      entityId: "evt-1",
      ipAddress: "203.0.113.9",
      userAgent: "loyverse-hook/1.0",
    });
    expect(rows[0].afterJson).toMatchObject({ eventType: "receipts.create" });
    expect(typeof rows[0].afterJson.externalEventId).toBe("string");
    // §24: the row must never carry the payload or signature material.
    expect(JSON.stringify(rows)).not.toContain("rcpt-1");
    expect(JSON.stringify(rows)).not.toContain(sign(RECEIPT_BODY));
  });

  it("replay: writes webhook.duplicate — a rejection with before/after JSON", async () => {
    mocks.webhookEventCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(res.status).toBe(200);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("webhook.duplicate");
    expect(rows[0].beforeJson).toMatchObject({
      eventType: "receipts.create",
    });
    expect(typeof rows[0].beforeJson.externalEventId).toBe("string");
    expect(rows[0].afterJson).toEqual({ received: true, duplicate: true });
  });

  it("invalid signature against a known merchant: 401 + webhook.verification_failed with IP", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, {
        "x-loyverse-signature": "deadbeef",
        "x-forwarded-for": "198.51.100.4",
      }),
    );
    expect(res.status).toBe(401);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "org-1",
      action: "webhook.verification_failed",
      ipAddress: "198.51.100.4",
      metadataJson: { reason: "invalid_signature", eventType: "receipts.create" },
    });
  });

  it("invalid signature from an unknown merchant: 401 and NO audit row (no org to attach)", async () => {
    vi.mocked(resolveWebhookOrganization).mockResolvedValue(null);

    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": "deadbeef" }),
    );
    expect(res.status).toBe(401);
    expect(auditRows()).toHaveLength(0);
  });

  it("queue outage after storing: 503 + webhook.enqueue_failed", async () => {
    vi.mocked(enqueueLoyverseWebhook).mockRejectedValue(
      new QueueUnavailableError({ cause: new Error("ECONNREFUSED") }),
    );

    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(res.status).toBe(503);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: "org-1",
      action: "webhook.enqueue_failed",
      entityId: "evt-1",
      afterJson: { received: true, enqueued: false },
    });
    expect(rows[0].metadataJson).toMatchObject({ eventType: "receipts.create" });
  });

  it("audit write failure does not change the HTTP outcome (writer never throws)", async () => {
    mocks.auditLogCreate.mockRejectedValue(new Error("db down"));

    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(res.status).toBe(202);
  });
});
