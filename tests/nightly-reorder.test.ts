/**
 * Nightly reorder-point recalculation (issue #33, SPEC.md §12).
 *
 * - velocity = net SALE+REFUND outflow over the 30-day lookback ÷ 30;
 * - reorderPoint = velocity × (lead + safety), targetStock = 2 × reorderPoint;
 * - the balance row is updated (it is the designated writer of
 *   reorderPoint/targetStock — #16's read model only renders them);
 * - one PENDING suggestion per below-target warehouse × variant, upserted
 *   in place, with suggestedQty = max(0, target − onHand − openOnOrder);
 * - every input recorded in `reason` (§12 requires visible inputs).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import {
  DEFAULT_LEAD_TIME_DAYS,
  REORDER_LOOKBACK_DAYS,
  SAFETY_STOCK_DAYS,
  recalculateReorderPoints,
} from "@/lib/maintenance/reorder";

const mocks = vi.hoisted(() => ({
  organizationFindMany: vi.fn(),
  inventoryBalanceFindMany: vi.fn(),
  inventoryBalanceUpdate: vi.fn(),
  inventoryMovementGroupBy: vi.fn(),
  purchaseOrderLineFindMany: vi.fn(),
  reorderSuggestionFindFirst: vi.fn(),
  reorderSuggestionCreate: vi.fn(),
  reorderSuggestionUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: { findMany: mocks.organizationFindMany },
    inventoryBalance: {
      findMany: mocks.inventoryBalanceFindMany,
      update: mocks.inventoryBalanceUpdate,
    },
    inventoryMovement: { groupBy: mocks.inventoryMovementGroupBy },
    purchaseOrderLine: { findMany: mocks.purchaseOrderLineFindMany },
    reorderSuggestion: {
      findFirst: mocks.reorderSuggestionFindFirst,
      create: mocks.reorderSuggestionCreate,
      update: mocks.reorderSuggestionUpdate,
    },
  },
}));

const NOW = new Date("2026-09-10T02:00:00.000Z");

function balance(overrides: Record<string, unknown> = {}) {
  return {
    id: "bal-1",
    organizationId: "org-1",
    warehouseId: "wh-1",
    variantId: "var-1",
    onHand: new Prisma.Decimal(5),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }]);
  mocks.inventoryMovementGroupBy.mockResolvedValue([]);
  mocks.purchaseOrderLineFindMany.mockResolvedValue([]);
  mocks.reorderSuggestionFindFirst.mockResolvedValue(null);
  mocks.reorderSuggestionCreate.mockResolvedValue({ id: "sug-1" });
  mocks.reorderSuggestionUpdate.mockResolvedValue({ id: "sug-1" });
  mocks.inventoryBalanceUpdate.mockResolvedValue({});
});

describe("recalculateReorderPoints", () => {
  it("computes velocity, reorder point, and target from net sales outflow", async () => {
    // 30 units sold, 3 returned over the lookback → net outflow 27 → 0.9/day.
    mocks.inventoryBalanceFindMany.mockResolvedValue([balance()]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal(-27) } },
    ]);

    const summary = await recalculateReorderPoints(NOW);

    const avg = new Prisma.Decimal(27).div(REORDER_LOOKBACK_DAYS); // 0.9
    const reorderPoint = avg.times(DEFAULT_LEAD_TIME_DAYS + SAFETY_STOCK_DAYS); // 12.6
    const targetStock = reorderPoint.times(2); // 25.2
    expect(mocks.inventoryBalanceUpdate).toHaveBeenCalledWith({
      where: { id: "bal-1" },
      data: { reorderPoint, targetStock },
    });
    // onHand 5, no onOrder → suggested 25.2 − 5 = 20.2
    expect(mocks.reorderSuggestionCreate).toHaveBeenCalledTimes(1);
    const created = mocks.reorderSuggestionCreate.mock.calls[0][0].data;
    expect(created.suggestedQty).toEqual(targetStock.minus(5));
    expect(created.reason).toMatchObject({
      averageDailySales: avg.toDecimalPlaces(3).toString(),
      leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
      safetyStockDays: SAFETY_STOCK_DAYS,
    });
    expect(summary).toMatchObject({ organizations: 1, balances: 1, updated: 1, suggested: 1 });
  });

  it("subtracts open approved-PO quantity from the suggestion", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([balance()]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal(-27) } },
    ]);
    // Ordered 10, received 4 → open 6.
    mocks.purchaseOrderLineFindMany.mockResolvedValue([
      {
        variantId: "var-1",
        quantity: new Prisma.Decimal(10),
        receivedQuantity: new Prisma.Decimal(4),
        purchaseOrder: { destinationWarehouseId: "wh-1" },
      },
    ]);

    await recalculateReorderPoints(NOW);

    const created = mocks.reorderSuggestionCreate.mock.calls[0][0].data;
    // 25.2 − 5 onHand − 6 onOrder = 14.2
    expect(created.suggestedQty).toEqual(new Prisma.Decimal("14.2"));
    expect(created.reason.onOrder).toBe("6");
  });

  it("updates an existing PENDING suggestion instead of duplicating it", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([balance()]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal(-30) } },
    ]);
    mocks.reorderSuggestionFindFirst.mockResolvedValue({ id: "sug-existing" });

    const summary = await recalculateReorderPoints(NOW);

    expect(mocks.reorderSuggestionCreate).not.toHaveBeenCalled();
    expect(mocks.reorderSuggestionUpdate).toHaveBeenCalledWith({
      where: { id: "sug-existing" },
      data: expect.objectContaining({ reorderPoint: expect.anything() }),
    });
    expect(summary.suggested).toBe(1);
  });

  it("writes no suggestion when stock covers the target", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([balance({ onHand: new Prisma.Decimal(100) })]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal(-30) } },
    ]);

    const summary = await recalculateReorderPoints(NOW);

    expect(mocks.reorderSuggestionCreate).not.toHaveBeenCalled();
    expect(mocks.reorderSuggestionFindFirst).not.toHaveBeenCalled();
    // Balance row is still recalculated (the job owns reorderPoint/targetStock).
    expect(mocks.inventoryBalanceUpdate).toHaveBeenCalledTimes(1);
    expect(summary.suggested).toBe(0);
  });

  it("zero velocity yields zero reorder point and no suggestion", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([balance({ onHand: new Prisma.Decimal(0) })]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([]);

    const summary = await recalculateReorderPoints(NOW);

    expect(mocks.inventoryBalanceUpdate).toHaveBeenCalledWith({
      where: { id: "bal-1" },
      data: { reorderPoint: new Prisma.Decimal(0), targetStock: new Prisma.Decimal(0) },
    });
    expect(mocks.reorderSuggestionCreate).not.toHaveBeenCalled();
    expect(summary.suggested).toBe(0);
  });

  it("scopes every query to the organization being processed", async () => {
    mocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }, { id: "org-2" }]);
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([]);

    await recalculateReorderPoints(NOW);

    for (const call of mocks.inventoryBalanceFindMany.mock.calls) {
      expect(call[0].where.organizationId).toMatch(/^org-[12]$/);
    }
    for (const call of mocks.inventoryMovementGroupBy.mock.calls) {
      expect(call[0].where.organizationId).toMatch(/^org-[12]$/);
    }
  });
});
