/**
 * POST /api/loyverse/webhook (SPEC.md §9 webhook flow, §18 webhook security,
 * §19 envelope, §24 logging). Covers the issue #9 acceptance criteria:
 * signature verification before parsing, malformed/replay rejection,
 * immutable event store, quick return after enqueueing, and §24's
 * "log event IDs + sanitized metadata, never full bodies".
 *
 * The real crypto verifier is used (§25 "webhook signature validation");
 * prisma, org resolution, rate limiting, and the queue handoff are mocked.
 */
import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/loyverse/webhook/route";
import {
  enqueueLoyverseWebhook,
  QueueUnavailableError,
} from "@/lib/queue/enqueue";
import { resolveWebhookOrganization } from "@/lib/loyverse/webhook/resolve-org";
import { payloadHash } from "@/lib/loyverse/webhook/verify";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { jobLog } from "@/worker/log";

const mocks = vi.hoisted(() => ({
  webhookEventCreate: vi.fn(),
  webhookEventUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEvent: {
      create: mocks.webhookEventCreate,
      update: mocks.webhookEventUpdate,
    },
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

vi.mock("@/worker/log", () => ({
  jobLog: vi.fn(),
}));

const SECRET = "test-webhook-secret";

const RECEIPT_BODY = JSON.stringify({
  merchant_id: "merchant-1",
  type: "receipts.create",
  created_at: "2024-01-15T10:30:45Z",
  receipts: [
    {
      id: "rcpt-1",
      store_id: "store-1",
      receipt_number: "R-1",
      total_money: 10,
    },
  ],
});

function sign(rawBody: string, secret: string = SECRET): string {
  return createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
}

function webhookRequest(
  rawBody: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new Request("http://localhost:3002/api/loyverse/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  }) as never;
}

function json(res: Response) {
  return res.json() as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOYVERSE_WEBHOOK_SECRET = SECRET;
  mocks.webhookEventCreate.mockResolvedValue({ id: "evt-1" });
  vi.mocked(resolveWebhookOrganization).mockResolvedValue("org-1");
  vi.mocked(checkRateLimit).mockReturnValue(true); // clearAllMocks keeps prior mockReturnValue
  vi.mocked(enqueueLoyverseWebhook).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.LOYVERSE_WEBHOOK_SECRET;
});

describe("POST /api/loyverse/webhook — signature verification (§18)", () => {
  it("accepts a valid X-Loyverse-Signature: stores the event and enqueues (202)", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.ok).toBe(true);

    expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          eventType: "receipts.create",
          signatureVerified: true,
          externalEventId: `sha256:${payloadHash(RECEIPT_BODY)}`,
          payloadHash: payloadHash(RECEIPT_BODY),
        }),
      }),
    );
    expect(vi.mocked(enqueueLoyverseWebhook)).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookEventId: "evt-1",
        organizationId: "org-1",
        eventType: "receipts.create",
      }),
    );
  });

  it("passes the FULL payload to the worker (resource arrays intact)", async () => {
    await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    const enqueued = vi.mocked(enqueueLoyverseWebhook).mock.calls[0][0];
    expect(enqueued.payload).toMatchObject({
      merchant_id: "merchant-1",
      receipts: [{ id: "rcpt-1" }],
    });
  });

  it("attributes from the FULL payload — store_id survives the envelope schema strip", async () => {
    // Regression (#11 E2E): zod's parsed.data only keeps envelope fields, so
    // attributing from it silently dropped store-based routing whenever no
    // LoyverseConnection merchant match existed.
    await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    const attributed = vi.mocked(resolveWebhookOrganization).mock.calls[0][0];
    expect(attributed.merchant_id).toBe("merchant-1");
    // store_id lives ONLY inside the receipt records — it survives only if the
    // full payload (not zod's stripped envelope) reaches the resolver.
    expect(attributed.receipts).toEqual([
      expect.objectContaining({ id: "rcpt-1", store_id: "store-1" }),
    ]);
  });

  it("rejects an invalid signature with 401 before storing anything", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": "deadbeef".repeat(5) }),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error!.code).toBe("INVALID_WEBHOOK_SIGNATURE");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueLoyverseWebhook)).not.toHaveBeenCalled();
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, {
        "x-loyverse-signature": sign(RECEIPT_BODY, "some-other-secret"),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts the bearer fallback when no signature header is present", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, { authorization: `Bearer ${SECRET}` }),
    );
    expect(res.status).toBe(202);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await POST(
      webhookRequest(RECEIPT_BODY, { authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });

  it("fails closed with 500 WEBHOOK_NOT_CONFIGURED when no secret is set", async () => {
    delete process.env.LOYVERSE_WEBHOOK_SECRET;
    const res = await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(res.status).toBe(500);
    expect((await json(res)).error!.code).toBe("WEBHOOK_NOT_CONFIGURED");
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });

  it("verifies BEFORE parsing: signed garbage body is 400, unsigned is 401", async () => {
    const unsigned = await POST(webhookRequest("not json"));
    expect(unsigned.status).toBe(401); // never even parsed

    const signedGarbage = await POST(
      webhookRequest("not json", { "x-loyverse-signature": sign("not json") }),
    );
    expect(signedGarbage.status).toBe(400);
    expect((await json(signedGarbage)).error!.code).toBe("INVALID_WEBHOOK_PAYLOAD");
  });
});

describe("POST /api/loyverse/webhook — validation, attribution, idempotency", () => {
  const signed = (raw: string) =>
    webhookRequest(raw, { "x-loyverse-signature": sign(raw) });

  it("rejects a validly-signed payload missing required fields (400)", async () => {
    const raw = JSON.stringify({ merchant_id: "m-1", created_at: "2024-01-15" });
    const res = await POST(signed(raw));
    expect(res.status).toBe(400);
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });

  it("acks and drops events for businesses this deployment does not serve (200 routed:false)", async () => {
    vi.mocked(resolveWebhookOrganization).mockResolvedValue(null);
    const res = await POST(signed(RECEIPT_BODY));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      data: { received: true, routed: false },
    });
    // Nothing stored, nothing enqueued — tenant ids from the body are never trusted.
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueLoyverseWebhook)).not.toHaveBeenCalled();
  });

  it("treats an exact replay as an idempotent ack (200 duplicate, no re-enqueue)", async () => {
    mocks.webhookEventCreate.mockRejectedValue({ code: "P2002" });
    const res = await POST(signed(RECEIPT_BODY));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      data: { received: true, duplicate: true },
    });
    expect(vi.mocked(enqueueLoyverseWebhook)).not.toHaveBeenCalled();
  });

  it("marks the event FAILED and returns 503 when the queue is unavailable", async () => {
    vi.mocked(enqueueLoyverseWebhook).mockRejectedValue(
      new QueueUnavailableError({ cause: new Error("ECONNREFUSED") }),
    );
    const res = await POST(signed(RECEIPT_BODY));
    expect(res.status).toBe(503);
    expect((await json(res)).error!.code).toBe("QUEUE_UNAVAILABLE");
    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evt-1" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("returns 429 when the source IP is rate limited", async () => {
    vi.mocked(checkRateLimit).mockReturnValue(false);
    const res = await POST(signed(RECEIPT_BODY));
    expect(res.status).toBe(429);
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const raw = JSON.stringify({ data: "x".repeat(300 * 1024) });
    const res = await POST(signed(raw));
    expect(res.status).toBe(400);
    expect(mocks.webhookEventCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/loyverse/webhook — §24 logging hygiene", () => {
  it("never logs full bodies, payloads, or the secret", async () => {
    await POST(
      webhookRequest(RECEIPT_BODY, { "x-loyverse-signature": sign(RECEIPT_BODY) }),
    );
    expect(vi.mocked(jobLog)).toHaveBeenCalled();
    for (const call of vi.mocked(jobLog).mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(RECEIPT_BODY);
      expect(serialized).not.toContain("rcpt-1");
      expect(serialized).not.toContain(SECRET);
    }
    // Sanitized identifiers ARE logged.
    const allFields = vi.mocked(jobLog).mock.calls.flatMap((call) => [call[2]]);
    expect(JSON.stringify(allFields)).toContain("receipts.create");
  });
});
