/**
 * process-loyverse-webhook (SPEC.md §9 webhook flow, §19 error taxonomy,
 * §24 logging/audit hygiene). Owns WebhookEvent RECEIVED →
 * PROCESSED/IGNORED/FAILED plus one sanitized AuditLog row per event.
 *
 * #11: receipts/refunds seen by an event enqueue finance-posting jobs AFTER
 * the event is marked PROCESSED — a queue blip must retry the job without
 * flipping the processed event to FAILED.
 */
import type { WebhookEvent } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processLoyverseWebhookJob } from "@/worker/processors/loyverse-webhook";
import { dispatchWebhookEvent } from "@/lib/loyverse/webhook/handlers";

const mocks = vi.hoisted(() => ({
  webhookEventFindUnique: vi.fn(),
  webhookEventUpdate: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEvent: {
      findUnique: mocks.webhookEventFindUnique,
      update: mocks.webhookEventUpdate,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock("@/lib/loyverse/webhook/handlers", () => ({
  dispatchWebhookEvent: vi.fn(),
}));

const enqueue = vi.hoisted(() => ({
  receipt: vi.fn(),
  refund: vi.fn(),
}));

vi.mock("@/lib/queue/enqueue", () => ({
  enqueueReceiptPosting: enqueue.receipt,
  enqueueRefundPosting: enqueue.refund,
}));

const EVENT: WebhookEvent = {
  id: "evt-1",
  organizationId: "org-1",
  externalEventId: "sha256:abc",
  eventType: "customers.update",
  signatureVerified: true,
  payloadHash: "abc",
  receivedAt: new Date("2026-09-09T00:00:00Z"),
  processedAt: null,
  status: "RECEIVED",
  error: null,
};

const PAYLOAD = { merchant_id: "m-1", customers: [{ id: "cust-1", name: "Jane" }] };

function fakeJob(data: Record<string, unknown>) {
  return { id: "job-1", data } as never;
}

const JOB_DATA = {
  webhookEventId: "evt-1",
  organizationId: "org-1",
  eventType: "customers.update",
  payload: PAYLOAD,
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.receipt.mockResolvedValue(undefined);
  enqueue.refund.mockResolvedValue(undefined);
  mocks.webhookEventFindUnique.mockResolvedValue(EVENT);
});

describe("processLoyverseWebhookJob — guards", () => {
  it("dead-letters permanently when the stored event does not exist", async () => {
    mocks.webhookEventFindUnique.mockResolvedValue(null);
    await expect(processLoyverseWebhookJob(fakeJob(JOB_DATA))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("dead-letters permanently on a cross-tenant organization mismatch", async () => {
    await expect(
      processLoyverseWebhookJob(fakeJob({ ...JOB_DATA, organizationId: "org-evil" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
  });

  it("dead-letters permanently when the job event type was tampered with", async () => {
    await expect(
      processLoyverseWebhookJob(fakeJob({ ...JOB_DATA, eventType: "receipts.create" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalled();
  });
});

describe("processLoyverseWebhookJob — state machine + audit", () => {
  it("PROCESSED: dispatches, marks PROCESSED, writes a sanitized audit row", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "PROCESSED",
      resource: "customers",
      records: 1,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
    });
    await processLoyverseWebhookJob(fakeJob(JOB_DATA));

    expect(dispatchWebhookEvent).toHaveBeenCalledWith({
      organizationId: "org-1",
      eventType: "customers.update",
      payload: PAYLOAD,
    });
    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "evt-1" },
        data: expect.objectContaining({ status: "PROCESSED", error: null }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          action: "webhook.processed",
          entityType: "WebhookEvent",
          entityId: "evt-1",
          metadataJson: expect.objectContaining({
            externalEventId: "sha256:abc",
            eventType: "customers.update",
            resource: "customers",
            records: 1,
          }),
        }),
      }),
    );
  });

  it("IGNORED: marks IGNORED and audits the note (deferred inventory path)", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "IGNORED",
      resource: "inventory_levels",
      records: 0,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
      note: "inventory projection deferred to the inventory issues",
    });
    await processLoyverseWebhookJob(fakeJob(JOB_DATA));

    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IGNORED" }),
      }),
    );
    const audit = mocks.auditLogCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("webhook.ignored");
    expect(audit.metadataJson.note).toContain("deferred");
  });

  it("permanent dispatch failure: marks FAILED with the safe message and rethrows", async () => {
    vi.mocked(dispatchWebhookEvent).mockRejectedValue(
      new UnrecoverableError(
        "Receipt webhook references store store-9 which is not synced yet.",
      ),
    );
    await expect(processLoyverseWebhookJob(fakeJob(JOB_DATA))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const final = mocks.webhookEventUpdate.mock.calls.at(-1)![0].data;
    expect(final.status).toBe("FAILED");
    expect(final.error).toContain("not synced yet");
    const audit = mocks.auditLogCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("webhook.failed");
    expect(audit.metadataJson.error).toContain("not synced yet");
  });

  it("transient failure: records a generic safe message and rethrows for retry", async () => {
    vi.mocked(dispatchWebhookEvent).mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );
    await expect(processLoyverseWebhookJob(fakeJob(JOB_DATA))).rejects.toBeInstanceOf(
      Error,
    );
    const final = mocks.webhookEventUpdate.mock.calls.at(-1)![0].data;
    expect(final.status).toBe("FAILED");
    // Internal driver details must never land in the event record (§19/§24).
    expect(final.error).not.toContain("ECONNREFUSED");
    expect(final.error).toBe("Unexpected worker error. Retry the job or contact support.");
  });
});

describe("processLoyverseWebhookJob — finance-posting enqueue (#11)", () => {
  it("enqueues posting jobs for the receipts and refunds the event wrote", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "PROCESSED",
      resource: "receipts",
      records: 2,
      refunds: 1,
      receiptIds: ["rec-1", "rec-2"],
      refundIds: ["ref-1"],
    });
    await processLoyverseWebhookJob(fakeJob(JOB_DATA));

    expect(enqueue.receipt).toHaveBeenCalledTimes(2);
    expect(enqueue.receipt).toHaveBeenCalledWith({ receiptId: "rec-1", organizationId: "org-1" });
    expect(enqueue.receipt).toHaveBeenCalledWith({ receiptId: "rec-2", organizationId: "org-1" });
    expect(enqueue.refund).toHaveBeenCalledTimes(1);
    expect(enqueue.refund).toHaveBeenCalledWith({ refundId: "ref-1", organizationId: "org-1" });
    // The event was already marked PROCESSED before the enqueue ran.
    expect(mocks.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) }),
    );
  });

  it("enqueues nothing for non-receipt resources", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "PROCESSED",
      resource: "customers",
      records: 1,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
    });
    await processLoyverseWebhookJob(fakeJob(JOB_DATA));
    expect(enqueue.receipt).not.toHaveBeenCalled();
    expect(enqueue.refund).not.toHaveBeenCalled();
  });

  it("an enqueue failure rejects for a BullMQ retry but leaves the event PROCESSED", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "PROCESSED",
      resource: "receipts",
      records: 1,
      refunds: 0,
      receiptIds: ["rec-1"],
      refundIds: [],
    });
    enqueue.receipt.mockRejectedValue(new Error("redis down"));

    await expect(processLoyverseWebhookJob(fakeJob(JOB_DATA))).rejects.toThrow("redis down");
    expect(mocks.webhookEventUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.webhookEventUpdate.mock.calls[0][0].data.status).toBe("PROCESSED");
    expect(mocks.webhookEventUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    // ...and no FAILED audit row either.
    const actions = mocks.auditLogCreate.mock.calls.map((c) => c[0].data.action);
    expect(actions).not.toContain("webhook.failed");
  });
});

describe("processLoyverseWebhookJob — §24 hygiene", () => {
  it("the audit row never contains the payload", async () => {
    vi.mocked(dispatchWebhookEvent).mockResolvedValue({
      status: "PROCESSED",
      resource: "customers",
      records: 1,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
    });
    await processLoyverseWebhookJob(fakeJob(JOB_DATA));
    const audit = JSON.stringify(mocks.auditLogCreate.mock.calls[0][0].data.metadataJson);
    expect(audit).not.toContain("Jane");
    expect(audit).not.toContain("cust-1");
  });
});
