/**
 * Inventory read model (issue #16, SPEC.md §6): org-scoped by construction,
 * with store/warehouse scope narrowing for scoped roles (§5). Balances derive
 * suggestedReorderQty (target − onHand, floored at 0, null without a target)
 * and lowStock (onHand ≤ reorderPoint); movements are cursor-paginated newest
 * first with a 200-row cap per page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listInventoryBalances,
  listInventoryMovements,
} from "@/lib/inventory/read";

const mocks = vi.hoisted(() => ({
  inventoryBalanceFindMany: vi.fn(),
  inventoryMovementFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    inventoryBalance: { findMany: mocks.inventoryBalanceFindMany },
    inventoryMovement: { findMany: mocks.inventoryMovementFindMany },
  },
}));

function balanceRow(overrides: Record<string, unknown> = {}) {
  return {
    onHand: "5",
    reserved: "0",
    reorderPoint: null,
    targetStock: null,
    variant: { id: "v-1", name: "Beans 1kg", sku: "B1", item: { id: "item-1", name: "Beans" } },
    warehouse: { id: "wh-1", name: "WH-MAIN", storeId: "store-1", store: { name: "Downtown" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listInventoryBalances", () => {
  it("derives lowStock and suggestedReorderQty and serializes decimals as strings", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      balanceRow({ onHand: "3", reorderPoint: "5", targetStock: "10" }),
      balanceRow({ onHand: "8", reorderPoint: "5", targetStock: "10" }),
      balanceRow({ onHand: "4" }), // no reorder fields configured
    ]);

    const rows = await listInventoryBalances("org-1", { storeIds: null, warehouseIds: null }, {});

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      onHand: "3",
      lowStock: true,
      suggestedReorderQty: "7",
      reorderPoint: "5",
      targetStock: "10",
      warehouse: { id: "wh-1", name: "WH-MAIN", storeId: "store-1", storeName: "Downtown" },
    });
    expect(rows[1]).toMatchObject({ lowStock: false, suggestedReorderQty: "2" });
    expect(rows[2]).toMatchObject({
      lowStock: false,
      suggestedReorderQty: null,
      reorderPoint: null,
      targetStock: null,
    });
  });

  it("floors suggestedReorderQty at zero when on-hand exceeds target", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      balanceRow({ onHand: "12", targetStock: "10" }),
    ]);
    const rows = await listInventoryBalances("org-1", { storeIds: null, warehouseIds: null }, {});
    expect(rows[0].suggestedReorderQty).toBe("0");
  });

  it("filters to low-stock rows with lowStock=1", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      balanceRow({ onHand: "3", reorderPoint: "5" }),
      balanceRow({ onHand: "9", reorderPoint: "5" }),
    ]);
    const rows = await listInventoryBalances(
      "org-1",
      { storeIds: null, warehouseIds: null },
      { lowStock: "1" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].onHand).toBe("3");
  });

  it("narrows store-scoped roles to their assigned stores", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);
    await listInventoryBalances("org-1", { storeIds: ["store-1", "store-2"], warehouseIds: null }, {});

    expect(mocks.inventoryBalanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { organizationId: "org-1" },
            { warehouse: { storeId: { in: ["store-1", "store-2"] } } },
          ]),
        }),
      }),
    );
  });

  it("narrows warehouse-scoped roles to their assigned warehouses", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);
    await listInventoryBalances("org-1", { storeIds: null, warehouseIds: ["wh-1"] }, {});

    expect(mocks.inventoryBalanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([{ warehouseId: { in: ["wh-1"] } }]),
        }),
      }),
    );
  });

  it("scopes unrestricted roles to nothing extra", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);
    await listInventoryBalances("org-1", { storeIds: null, warehouseIds: null }, {});
    const where = mocks.inventoryBalanceFindMany.mock.calls[0][0].where as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND).toEqual([{ organizationId: "org-1" }]);
  });

  it("rejects invalid filters with a 400 InventoryError", async () => {
    await expect(
      listInventoryBalances("org-1", { storeIds: null, warehouseIds: null }, { lowStock: 42 }),
    ).rejects.toMatchObject({ name: "InventoryError", status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.inventoryBalanceFindMany).not.toHaveBeenCalled();
  });
});

describe("listInventoryMovements", () => {
  function movementRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "mov-1",
      createdAt: new Date("2026-09-10T12:00:00Z"),
      quantityDelta: "-2",
      type: "SALE",
      referenceType: "Receipt",
      referenceId: "rec-1",
      variant: { id: "v-1", name: "Beans 1kg", item: { name: "Beans" } },
      warehouse: { id: "wh-1", name: "WH-MAIN", store: { name: "Downtown" } },
      ...overrides,
    };
  }

  it("returns a newest-first page with serialized quantities", async () => {
    mocks.inventoryMovementFindMany.mockResolvedValue([movementRow()]);

    const result = await listInventoryMovements(
      "org-1",
      { storeIds: null, warehouseIds: null },
      {},
    );

    expect(result.nextCursor).toBeNull();
    expect(result.entries[0]).toMatchObject({
      id: "mov-1",
      createdAt: "2026-09-10T12:00:00.000Z",
      quantityDelta: "-2",
      type: "SALE",
      variant: { id: "v-1", name: "Beans 1kg", itemName: "Beans" },
      warehouse: { id: "wh-1", name: "WH-MAIN", storeName: "Downtown" },
    });
    expect(mocks.inventoryMovementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 51,
      }),
    );
  });

  it("caps limit at 200 and supports cursor continuation", async () => {
    mocks.inventoryMovementFindMany.mockResolvedValue([]);

    await listInventoryMovements(
      "org-1",
      { storeIds: null, warehouseIds: null },
      { limit: 150, cursor: "mov-9" },
    );

    expect(mocks.inventoryMovementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 151, cursor: { id: "mov-9" }, skip: 1 }),
    );
  });

  it("rejects a limit above the 200 cap", async () => {
    await expect(
      listInventoryMovements(
        "org-1",
        { storeIds: null, warehouseIds: null },
        { limit: 999 },
      ),
    ).rejects.toMatchObject({ name: "InventoryError", status: 400 });
  });

  it("exposes a nextCursor when more rows exist", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => movementRow({ id: `mov-${i}` }));
    mocks.inventoryMovementFindMany.mockResolvedValue(rows);

    const result = await listInventoryMovements(
      "org-1",
      { storeIds: null, warehouseIds: null },
      {},
    );
    expect(result.entries).toHaveLength(50);
    expect(result.nextCursor).toBe("mov-49");
  });

  it("applies type, date-range, and dimension filters", async () => {
    mocks.inventoryMovementFindMany.mockResolvedValue([]);

    await listInventoryMovements(
      "org-1",
      { storeIds: null, warehouseIds: null },
      {
        type: "SALE",
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-30T23:59:59Z",
        itemId: "item-1",
        variantId: "v-1",
        storeId: "store-1",
        warehouseId: "wh-1",
      },
    );

    const where = mocks.inventoryMovementFindMany.mock.calls[0][0].where as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { organizationId: "org-1" },
        { type: "SALE" },
        { warehouse: { storeId: "store-1" } },
        { warehouseId: "wh-1" },
        { variant: { itemId: "item-1" } },
        { variantId: "v-1" },
        { createdAt: { gte: new Date("2026-09-01T00:00:00Z"), lte: new Date("2026-09-30T23:59:59Z") } },
      ]),
    );
  });

  it("rejects an unknown movement type", async () => {
    await expect(
      listInventoryMovements(
        "org-1",
        { storeIds: null, warehouseIds: null },
        { type: "TELEPORT" as never },
      ),
    ).rejects.toMatchObject({ name: "InventoryError", status: 400 });
    expect(mocks.inventoryMovementFindMany).not.toHaveBeenCalled();
  });

  it("rejects malformed dates", async () => {
    await expect(
      listInventoryMovements(
        "org-1",
        { storeIds: null, warehouseIds: null },
        { from: "not-a-date" },
      ),
    ).rejects.toMatchObject({ name: "InventoryError", status: 400 });
  });
});
