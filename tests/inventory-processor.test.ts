/**
 * Inventory queue processors (issue #16): projection jobs and stock
 * write-back jobs. Operator configuration gaps (InventoryError, e.g.
 * WAREHOUSE_NOT_MAPPED) are permanent — they dead-letter via
 * UnrecoverableError with the safe message; transient failures rethrow for
 * BullMQ's own retry policy (§19).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";

import { InventoryError } from "@/lib/inventory/errors";
import {
  processApplyInventoryJob,
  processStockWritebackJob,
} from "@/worker/processors/inventory";

const mocks = vi.hoisted(() => ({
  applyReceiptSale: vi.fn(),
  applyRefundReturn: vi.fn(),
  performStockWriteback: vi.fn(),
}));

vi.mock("@/lib/inventory/projection", () => ({
  applyReceiptSale: mocks.applyReceiptSale,
  applyRefundReturn: mocks.applyRefundReturn,
}));

vi.mock("@/lib/loyverse/stock-writeback", () => ({
  performStockWriteback: mocks.performStockWriteback,
}));

function job(data: Record<string, unknown>) {
  return { id: "job-1", data } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processApplyInventoryJob", () => {
  it("applies a receipt projection", async () => {
    mocks.applyReceiptSale.mockResolvedValue({ movements: 2, alreadyApplied: 0 });

    await processApplyInventoryJob(job({ kind: "receipt", sourceId: "rec-1", organizationId: "org-1" }));

    expect(mocks.applyReceiptSale).toHaveBeenCalledWith("org-1", "rec-1");
  });

  it("applies a refund projection", async () => {
    mocks.applyRefundReturn.mockResolvedValue({ movements: 1, alreadyApplied: 0 });

    await processApplyInventoryJob(job({ kind: "refund", sourceId: "ref-1", organizationId: "org-1" }));

    expect(mocks.applyRefundReturn).toHaveBeenCalledWith("org-1", "ref-1");
  });

  it("InventoryError (config gap) → UnrecoverableError so it dead-letters, not retries", async () => {
    mocks.applyReceiptSale.mockRejectedValue(
      new InventoryError(400, "WAREHOUSE_NOT_MAPPED", "Create a warehouse for the store under Settings - Warehouses."),
    );

    await expect(
      processApplyInventoryJob(job({ kind: "receipt", sourceId: "rec-1", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("unexpected failures rethrow unchanged for BullMQ retry", async () => {
    mocks.applyReceiptSale.mockRejectedValue(new Error("connection lost"));

    await expect(
      processApplyInventoryJob(job({ kind: "receipt", sourceId: "rec-1", organizationId: "org-1" })),
    ).rejects.toThrow("connection lost");
  });
});

describe("processStockWritebackJob", () => {
  it("delivers a write-back", async () => {
    mocks.performStockWriteback.mockResolvedValue({ status: "SUCCEEDED" });

    await processStockWritebackJob(
      job({ stockWritebackRequestId: "wb-1", organizationId: "org-1" }),
    );

    expect(mocks.performStockWriteback).toHaveBeenCalledWith("wb-1", "org-1");
  });

  it("InventoryError → UnrecoverableError", async () => {
    mocks.performStockWriteback.mockRejectedValue(
      new InventoryError(400, "VARIANT_NOT_SYNCED", "Run a sync first."),
    );

    await expect(
      processStockWritebackJob(job({ stockWritebackRequestId: "wb-1", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
