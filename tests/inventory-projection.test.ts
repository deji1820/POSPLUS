/**
 * Inventory projection (issue #16, SPEC.md §8): balances are ONLY written as
 * Σ immutable movements. Acceptance by construction:
 *   - applyMovement commits movement + balance increment in ONE transaction;
 *   - a P2002 on the per-org dedupe key means the pair already committed —
 *     the retry reports alreadyApplied instead of double-applying;
 *   - receipts project per-line SALE movements (negative), refunds per-line
 *     REFUND movements (positive), each idempotent per source line;
 *   - a store with no linked warehouse is an operator configuration gap
 *     (InventoryError WAREHOUSE_NOT_MAPPED), never a silent stock drop;
 *   - inventory_levels snapshots apply the delta reported − on-hand, seed
 *     from zero on first sight, write nothing on zero delta, and skip
 *     unknown variant/store rows for the sync to repair.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import {
  applyInventoryLevelSnapshot,
  applyMovement,
  applyReceiptSale,
  applyRefundReturn,
  resolveWarehouseId,
} from "@/lib/inventory/projection";

const mocks = vi.hoisted(() => ({
  warehouseFindFirst: vi.fn(),
  variantFindFirst: vi.fn(),
  storeFindFirst: vi.fn(),
  inventoryBalanceFindFirst: vi.fn(),
  inventoryMovementCreate: vi.fn(),
  inventoryBalanceUpsert: vi.fn(),
  receiptFindFirst: vi.fn(),
  refundFindFirst: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    warehouse: { findFirst: mocks.warehouseFindFirst },
    variant: { findFirst: mocks.variantFindFirst },
    store: { findFirst: mocks.storeFindFirst },
    inventoryBalance: {
      findFirst: mocks.inventoryBalanceFindFirst,
      upsert: mocks.inventoryBalanceUpsert,
    },
    inventoryMovement: { create: mocks.inventoryMovementCreate },
    receipt: { findFirst: mocks.receiptFindFirst },
    refund: { findFirst: mocks.refundFindFirst },
    $transaction: mocks.$transaction,
  },
}));

/** Run the callback with a fake tx whose writes go to the hoisted mocks. */
function setupTransaction(): void {
  mocks.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      inventoryMovement: { create: mocks.inventoryMovementCreate },
      inventoryBalance: { upsert: mocks.inventoryBalanceUpsert },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setupTransaction();
  mocks.warehouseFindFirst.mockResolvedValue({ id: "wh-1" });
});

describe("applyMovement", () => {
  it("commits movement + balance upsert in one transaction", async () => {
    const result = await applyMovement({
      organizationId: "org-1",
      warehouseId: "wh-1",
      variantId: "v-1",
      quantityDelta: new Prisma.Decimal(-2),
      type: "SALE",
      referenceType: "Receipt",
      referenceId: "rec-1",
      dedupeKey: "sale:line-1",
    });

    expect(result.alreadyApplied).toBe(false);
    expect(mocks.inventoryMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        warehouseId: "wh-1",
        variantId: "v-1",
        type: "SALE",
        dedupeKey: "sale:line-1",
        referenceType: "Receipt",
        referenceId: "rec-1",
      }),
    });
    expect(mocks.inventoryBalanceUpsert).toHaveBeenCalledWith({
      where: { warehouseId_variantId: { warehouseId: "wh-1", variantId: "v-1" } },
      create: expect.objectContaining({ onHand: expect.anything() }),
      update: { onHand: { increment: expect.anything() } },
    });
  });

  it("treats a dedupe-key P2002 as already applied (retry is a no-op)", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mocks.$transaction.mockRejectedValueOnce(p2002);

    const result = await applyMovement({
      organizationId: "org-1",
      warehouseId: "wh-1",
      variantId: "v-1",
      quantityDelta: new Prisma.Decimal(-2),
      type: "SALE",
      dedupeKey: "sale:line-1",
    });

    expect(result.alreadyApplied).toBe(true);
    // The balance was never touched — the pair committed on the first attempt.
    expect(mocks.inventoryBalanceUpsert).not.toHaveBeenCalled();
  });

  it("rethrows non-unique failures", async () => {
    mocks.$transaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      applyMovement({
        organizationId: "org-1",
        warehouseId: "wh-1",
        variantId: "v-1",
        quantityDelta: new Prisma.Decimal(1),
        type: "ADJUSTMENT",
        dedupeKey: "adj:1",
      }),
    ).rejects.toThrow("connection lost");
  });
});

describe("resolveWarehouseId", () => {
  it("returns the store-linked warehouse", async () => {
    await expect(resolveWarehouseId("org-1", "store-1")).resolves.toBe("wh-1");
    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1", storeId: "store-1" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
  });

  it("returns null when the store has no warehouse", async () => {
    mocks.warehouseFindFirst.mockResolvedValue(null);
    await expect(resolveWarehouseId("org-1", "store-1")).resolves.toBeNull();
  });
});

describe("applyReceiptSale", () => {
  const RECEIPT = {
    id: "rec-1",
    storeId: "store-1",
    lines: [
      { id: "line-1", variantId: "v-1", quantity: "2" },
      { id: "line-2", variantId: null, quantity: "1" }, // non-variant line — skipped
      { id: "line-3", variantId: "v-2", quantity: "0.5" },
    ],
  };

  it("projects one negative SALE movement per variant line", async () => {
    mocks.receiptFindFirst.mockResolvedValue(RECEIPT);

    const result = await applyReceiptSale("org-1", "rec-1");

    expect(result).toEqual({ movements: 2, alreadyApplied: 0 });
    const deltas = mocks.inventoryMovementCreate.mock.calls.map(
      (call) => (call[0] as { data: { quantityDelta: Prisma.Decimal } }).data.quantityDelta,
    );
    expect(deltas.map((d) => d.toString())).toEqual(["-2", "-0.5"]);
    expect(mocks.inventoryMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "SALE", dedupeKey: "sale:line-1", referenceId: "rec-1" }),
    });
  });

  it("is idempotent per line when a replay hits the dedupe key", async () => {
    mocks.receiptFindFirst.mockResolvedValue(RECEIPT);
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    // First transaction (line-1) hits the dedupe key; the beforeEach default
    // implementation serves the remaining lines.
    mocks.$transaction.mockRejectedValueOnce(p2002);

    const result = await applyReceiptSale("org-1", "rec-1");
    expect(result).toEqual({ movements: 1, alreadyApplied: 1 });
  });

  it("throws InventoryError when the receipt's store has no warehouse", async () => {
    mocks.receiptFindFirst.mockResolvedValue(RECEIPT);
    mocks.warehouseFindFirst.mockResolvedValue(null);

    await expect(applyReceiptSale("org-1", "rec-1")).rejects.toMatchObject({
      name: "InventoryError",
      code: "WAREHOUSE_NOT_MAPPED",
      status: 400,
    });
    expect(mocks.inventoryMovementCreate).not.toHaveBeenCalled();
  });

  it("throws a 404 for an unknown receipt", async () => {
    mocks.receiptFindFirst.mockResolvedValue(null);
    await expect(applyReceiptSale("org-1", "missing")).rejects.toMatchObject({
      name: "InventoryError",
      status: 404,
    });
  });
});

describe("applyRefundReturn", () => {
  it("projects one positive REFUND movement per variant line", async () => {
    mocks.refundFindFirst.mockResolvedValue({
      id: "ref-1",
      receipt: { id: "rec-1", storeId: "store-1" },
      lines: [{ id: "rline-1", variantId: "v-1", quantity: "1" }],
    });

    const result = await applyRefundReturn("org-1", "ref-1");

    expect(result).toEqual({ movements: 1, alreadyApplied: 0 });
    expect(mocks.inventoryMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "REFUND",
        dedupeKey: "refund-return:rline-1",
        referenceId: "ref-1",
      }),
    });
    const delta = (mocks.inventoryMovementCreate.mock.calls[0][0] as {
      data: { quantityDelta: Prisma.Decimal };
    }).data.quantityDelta;
    expect(delta.toString()).toBe("1"); // stock back IN
  });
});

describe("applyInventoryLevelSnapshot", () => {
  const SNAPSHOT = {
    variantLoyverseId: "lv-var-1",
    storeLoyverseId: "seed-store-1",
    inStock: new Prisma.Decimal("7"),
    dedupeKey: "snapshot:evt-1:lv-var-1:seed-store-1",
  };

  function setupKnownVariantAndStore(balance: { onHand: unknown } | null): void {
    mocks.variantFindFirst.mockResolvedValue({ id: "v-1" });
    mocks.storeFindFirst.mockResolvedValue({ id: "store-1" });
    mocks.inventoryBalanceFindFirst.mockResolvedValue(balance);
  }

  it("seeds from zero on first sight (balance is Σ movements)", async () => {
    setupKnownVariantAndStore(null);

    const outcome = await applyInventoryLevelSnapshot("org-1", SNAPSHOT);

    expect(outcome.status).toBe("applied");
    const delta = (mocks.inventoryMovementCreate.mock.calls[0][0] as {
      data: { quantityDelta: Prisma.Decimal; type: string };
    }).data;
    expect(delta.quantityDelta.toString()).toBe("7");
    expect(delta.type).toBe("ADJUSTMENT");
  });

  it("applies the delta between reported stock and current on-hand", async () => {
    setupKnownVariantAndStore({ onHand: "10" });

    const outcome = await applyInventoryLevelSnapshot("org-1", {
      ...SNAPSHOT,
      inStock: new Prisma.Decimal("8"),
    });

    expect(outcome.status).toBe("applied");
    const delta = (mocks.inventoryMovementCreate.mock.calls[0][0] as {
      data: { quantityDelta: Prisma.Decimal };
    }).data.quantityDelta;
    expect(delta.toString()).toBe("-2");
  });

  it("writes no movement when the snapshot matches on-hand", async () => {
    setupKnownVariantAndStore({ onHand: "7" });

    const outcome = await applyInventoryLevelSnapshot("org-1", SNAPSHOT);

    expect(outcome.status).toBe("noChange");
    expect(mocks.inventoryMovementCreate).not.toHaveBeenCalled();
    expect(mocks.inventoryBalanceUpsert).not.toHaveBeenCalled();
  });

  it("skips unknown variants for the sync to repair", async () => {
    mocks.variantFindFirst.mockResolvedValue(null);
    const outcome = await applyInventoryLevelSnapshot("org-1", SNAPSHOT);
    expect(outcome).toEqual({ status: "skipped", reason: "unknown-variant" });
    expect(mocks.inventoryMovementCreate).not.toHaveBeenCalled();
  });

  it("skips unknown stores", async () => {
    mocks.variantFindFirst.mockResolvedValue({ id: "v-1" });
    mocks.storeFindFirst.mockResolvedValue(null);
    const outcome = await applyInventoryLevelSnapshot("org-1", SNAPSHOT);
    expect(outcome).toEqual({ status: "skipped", reason: "unknown-store" });
  });

  it("skips when the store has no linked warehouse", async () => {
    mocks.variantFindFirst.mockResolvedValue({ id: "v-1" });
    mocks.storeFindFirst.mockResolvedValue({ id: "store-1" });
    mocks.warehouseFindFirst.mockResolvedValue(null);
    const outcome = await applyInventoryLevelSnapshot("org-1", SNAPSHOT);
    expect(outcome).toEqual({ status: "skipped", reason: "no-warehouse" });
  });
});
