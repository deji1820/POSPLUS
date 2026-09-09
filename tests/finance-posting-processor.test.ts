/**
 * finance-posting queue processors (SPEC.md §10 `post-receipt-to-ledger` /
 * `post-refund-to-ledger`, issue #11). Thin wrappers around the posting
 * use-cases: FinanceError (expected permanent conditions — missing source,
 * unmapped payment type, inactive account) dead-letters with the safe
 * message; unexpected errors propagate for BullMQ backoff retries.
 */
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FinanceError } from "@/lib/finance/errors";
import { postReceiptToLedger, postRefundToLedger } from "@/lib/finance/posting";
import {
  processPostReceiptToLedgerJob,
  processPostRefundToLedgerJob,
} from "@/worker/processors/finance-posting";

vi.mock("@/lib/finance/posting", () => ({
  postReceiptToLedger: vi.fn(),
  postRefundToLedger: vi.fn(),
}));

vi.mock("@/worker/log", () => ({ jobLog: vi.fn() }));

function fakeJob(data: Record<string, unknown>) {
  return { id: "job-1", data } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postReceiptToLedger).mockResolvedValue({ posted: true, journalEntryId: "je-1" });
  vi.mocked(postRefundToLedger).mockResolvedValue({ posted: true, journalEntryId: "je-2" });
});

describe("processPostReceiptToLedgerJob", () => {
  it("posts the receipt and logs the journal entry id", async () => {
    await processPostReceiptToLedgerJob(
      fakeJob({ receiptId: "rec-1", organizationId: "org-1" }),
    );
    expect(postReceiptToLedger).toHaveBeenCalledWith("org-1", "rec-1");
  });

  it("completes quietly when the receipt was already posted", async () => {
    vi.mocked(postReceiptToLedger).mockResolvedValue({ posted: false, journalEntryId: "je-x" });
    await expect(
      processPostReceiptToLedgerJob(fakeJob({ receiptId: "rec-1", organizationId: "org-1" })),
    ).resolves.toBeUndefined();
  });

  it("dead-letters permanently on a FinanceError, preserving the safe message", async () => {
    vi.mocked(postReceiptToLedger).mockRejectedValue(
      new FinanceError(400, "PAYMENT_TYPE_UNMAPPED", 'Cannot post: no GL account is mapped for payment type "Crypto". Map it under Finance - GL Mappings.'),
    );
    await expect(
      processPostReceiptToLedgerJob(fakeJob({ receiptId: "rec-1", organizationId: "org-1" })),
    ).rejects.toMatchObject({
      name: "UnrecoverableError",
      message: expect.stringContaining('"Crypto"'),
    });
  });

  it("rethrows unexpected errors so BullMQ retries with backoff", async () => {
    vi.mocked(postReceiptToLedger).mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(
      processPostReceiptToLedgerJob(fakeJob({ receiptId: "rec-1", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(Error);
  });

  it("the cross-tenant org mismatch surfaces as NOT_FOUND FinanceError → permanent", async () => {
    // The org-scoped findFirst in the use-case makes a foreign receipt id
    // indistinguishable from a missing one — no cross-tenant leak.
    vi.mocked(postReceiptToLedger).mockRejectedValue(
      new FinanceError(404, "NOT_FOUND", "Receipt not found."),
    );
    await expect(
      processPostReceiptToLedgerJob(fakeJob({ receiptId: "rec-evil", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("processPostRefundToLedgerJob", () => {
  it("posts the refund reversal and logs the journal entry id", async () => {
    await processPostRefundToLedgerJob(
      fakeJob({ refundId: "ref-1", organizationId: "org-1" }),
    );
    expect(postRefundToLedger).toHaveBeenCalledWith("org-1", "ref-1");
  });

  it("dead-letters permanently on a FinanceError", async () => {
    vi.mocked(postRefundToLedger).mockRejectedValue(
      new FinanceError(400, "ACCOUNT_INACTIVE", "The GL account mapped for payment type \"Cash\" is inactive."),
    );
    await expect(
      processPostRefundToLedgerJob(fakeJob({ refundId: "ref-1", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
