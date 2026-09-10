/**
 * Reorder suggestion workflow (issue #17, SPEC.md §12).
 *
 * - listPendingSuggestions scopes by org and surfaces the §12 inputs stored
 *   in `reason` so the UI can show them per suggestion;
 * - acceptSuggestion creates a Draft PO + line, marks the suggestion
 *   ACCEPTED, and audits — atomically, org-scoped, with a P2002 retry on
 *   PO-number allocation;
 * - dismissSuggestion flips PENDING → DISMISSED once and audits; anything
 *   already handled (or another org's) is a domain error, not a silent
 *   no-op.
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReorderSuggestionNotFoundError,
  ReorderSupplierNotFoundError,
} from "@/lib/reorder/errors";

const mocks = vi.hoisted(() => ({
  suggestionFindFirst: vi.fn(),
  suggestionFindMany: vi.fn(),
  suggestionUpdate: vi.fn(),
  suggestionUpdateMany: vi.fn(),
  supplierFindFirst: vi.fn(),
  poCreate: vi.fn(),
  lineCreate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    reorderSuggestion: {
      findFirst: mocks.suggestionFindFirst,
      findMany: mocks.suggestionFindMany,
      update: mocks.suggestionUpdate,
      updateMany: mocks.suggestionUpdateMany,
    },
    supplier: { findFirst: mocks.supplierFindFirst },
    purchaseOrder: { create: mocks.poCreate },
    purchaseOrderLine: { create: mocks.lineCreate },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit/writer", () => ({
  AUDIT_ACTIONS: {
    REORDER: {
      SUGGESTION_ACCEPTED: "reorder.accepted",
      SUGGESTION_DISMISSED: "reorder.dismissed",
    },
  },
  writeAudit: mocks.writeAudit,
}));

import {
  acceptSuggestion,
  dismissSuggestion,
  listPendingSuggestions,
} from "@/lib/reorder/suggestions";

const ORG = "org-1";
const OTHER_ORG = "org-2";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAudit.mockResolvedValue(undefined);
});

describe("listPendingSuggestions", () => {
  it("scopes to the org and parses the §12 inputs from reason", async () => {
    mocks.suggestionFindMany.mockResolvedValue([
      {
        id: "s-1",
        organizationId: ORG,
        suggestedQty: new Prisma.Decimal(40),
        averageDailySales: new Prisma.Decimal(2),
        reorderPoint: new Prisma.Decimal(28),
        createdAt: new Date("2026-09-08T02:00:00Z"),
        reason: {
          lookbackDays: 30,
          averageDailySales: "2.000",
          leadTimeDays: 7,
          safetyStockDays: 7,
          reorderPoint: "28.000",
          targetStock: "56.000",
          onHand: "10.000",
          onOrder: "6.000",
          computedAt: "2026-09-08T02:00:00.000Z",
        },
        variant: { name: "Whole bean 1kg", sku: "WB-1KG", item: { name: "Coffee" } },
        warehouse: { name: "Main Warehouse" },
      },
    ]);

    const rows = await listPendingSuggestions(ORG);

    expect(mocks.suggestionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, status: "PENDING" },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s-1",
      itemName: "Coffee",
      variantName: "Whole bean 1kg",
      variantSku: "WB-1KG",
      warehouseName: "Main Warehouse",
      suggestedQty: "40",
      inputs: {
        lookbackDays: 30,
        averageDailySales: "2.000",
        leadTimeDays: 7,
        safetyStockDays: 7,
        reorderPoint: "28.000",
        targetStock: "56.000",
        onHand: "10.000",
        onOrder: "6.000",
        computedAt: "2026-09-08T02:00:00.000Z",
      },
    });
  });

  it("returns null inputs when the job stored no reason", async () => {
    mocks.suggestionFindMany.mockResolvedValue([
      {
        id: "s-2",
        suggestedQty: new Prisma.Decimal(5),
        averageDailySales: new Prisma.Decimal(1),
        reorderPoint: new Prisma.Decimal(14),
        createdAt: new Date("2026-09-08T02:00:00Z"),
        reason: null,
        variant: { name: "V", sku: null, item: { name: "I" } },
        warehouse: { name: "W" },
      },
    ]);

    const rows = await listPendingSuggestions(ORG);
    expect(rows[0].inputs).toBeNull();
  });
});

describe("acceptSuggestion", () => {
  const baseSuggestion = {
    id: "s-1",
    organizationId: ORG,
    warehouseId: "wh-1",
    variantId: "v-1",
    suggestedQty: new Prisma.Decimal(40),
    variant: { defaultCost: new Prisma.Decimal(12.5) },
  };

  function primeAccept() {
    mocks.suggestionFindFirst.mockResolvedValue(baseSuggestion);
    mocks.supplierFindFirst.mockResolvedValue({ id: "sup-1" });
    mocks.poCreate.mockResolvedValue({ id: "po-1", number: "PO-20260908-001" });
    mocks.lineCreate.mockResolvedValue({ id: "line-1" });
    mocks.suggestionUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        purchaseOrder: { create: mocks.poCreate },
        purchaseOrderLine: { create: mocks.lineCreate },
        reorderSuggestion: { update: mocks.suggestionUpdate, updateMany: mocks.suggestionUpdateMany },
        auditLog: { create: mocks.auditCreate },
      }),
    );
  }

  it("creates a Draft PO with one line, marks ACCEPTED, and audits after commit", async () => {
    primeAccept();

    const result = await acceptSuggestion(ORG, "user-1", {
      suggestionId: "s-1",
      supplierId: "sup-1",
    });

    expect(result).toEqual({ purchaseOrderId: "po-1", purchaseOrderNumber: "PO-20260908-001" });
    expect(mocks.suggestionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s-1", organizationId: ORG, status: "PENDING" },
      }),
    );
    expect(mocks.poCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        number: expect.stringMatching(/^PO-\d{8}-001$/),
        supplierId: "sup-1",
        destinationWarehouseId: "wh-1",
        status: "DRAFT",
        subtotal: expect.any(Prisma.Decimal),
        total: expect.any(Prisma.Decimal),
        createdById: "user-1",
      }),
      select: { id: true, number: true },
    });
    const poData = mocks.poCreate.mock.calls[0][0].data as {
      subtotal: Prisma.Decimal;
      total: Prisma.Decimal;
    };
    expect(poData.subtotal.toString()).toBe("500");
    expect(poData.total.toString()).toBe("500");
    expect(mocks.lineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        purchaseOrderId: "po-1",
        variantId: "v-1",
        quantity: expect.any(Prisma.Decimal),
        unitPrice: expect.any(Prisma.Decimal),
      }),
    });
    const lineData = mocks.lineCreate.mock.calls[0][0].data as {
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
    };
    expect(lineData.quantity.toString()).toBe("40");
    expect(lineData.unitPrice.toString()).toBe("12.5");
    expect(mocks.suggestionUpdate).toHaveBeenCalledWith({
      where: { id: "s-1" },
      data: { status: "ACCEPTED" },
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actorUserId: "user-1",
        action: "reorder.accepted",
        entityType: "ReorderSuggestion",
        entityId: "s-1",
        afterJson: expect.objectContaining({
          status: "ACCEPTED",
          purchaseOrderId: "po-1",
          purchaseOrderNumber: expect.stringMatching(/^PO-\d{8}-001$/),
          supplierId: "sup-1",
          quantity: "40",
          unitPrice: "12.5",
        }),
      }),
    );
  });

  it("uses a zero unit price when the variant has no default cost", async () => {
    primeAccept();
    mocks.suggestionFindFirst.mockResolvedValue({
      ...baseSuggestion,
      variant: { defaultCost: null },
    });

    await acceptSuggestion(ORG, "user-1", { suggestionId: "s-1", supplierId: "sup-1" });

    const lineData = mocks.lineCreate.mock.calls[0][0].data as { unitPrice: Prisma.Decimal };
    expect(lineData.unitPrice.toString()).toBe("0");
  });

  it("throws NotFound for another org's or already-handled suggestion", async () => {
    mocks.suggestionFindFirst.mockResolvedValue(null);
    await expect(
      acceptSuggestion(OTHER_ORG, "user-1", { suggestionId: "s-1", supplierId: "sup-1" }),
    ).rejects.toThrow(ReorderSuggestionNotFoundError);
  });

  it("throws when the supplier is missing, cross-org, or inactive", async () => {
    mocks.suggestionFindFirst.mockResolvedValue(baseSuggestion);
    mocks.supplierFindFirst.mockResolvedValue(null);

    await expect(
      acceptSuggestion(ORG, "user-1", { suggestionId: "s-1", supplierId: "sup-1" }),
    ).rejects.toThrow(ReorderSupplierNotFoundError);
    expect(mocks.poCreate).not.toHaveBeenCalled();
  });

  it("retries the PO number once on a unique collision", async () => {
    primeAccept();
    mocks.poCreate
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "7" }),
      )
      .mockResolvedValueOnce({ id: "po-2", number: "PO-20260908-002" });

    const result = await acceptSuggestion(ORG, "user-1", {
      suggestionId: "s-1",
      supplierId: "sup-1",
    });

    expect(result.purchaseOrderNumber).toBe("PO-20260908-002");
    expect(mocks.poCreate).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-collision failures without retrying", async () => {
    primeAccept();
    mocks.poCreate.mockRejectedValue(new Error("db gone"));

    await expect(
      acceptSuggestion(ORG, "user-1", { suggestionId: "s-1", supplierId: "sup-1" }),
    ).rejects.toThrow("db gone");
    expect(mocks.poCreate).toHaveBeenCalledTimes(1);
  });
});

describe("dismissSuggestion", () => {
  it("flips PENDING → DISMISSED once and audits", async () => {
    mocks.suggestionUpdateMany.mockResolvedValue({ count: 1 });

    await dismissSuggestion(ORG, "user-1", "s-1");

    expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
      where: { id: "s-1", organizationId: ORG, status: "PENDING" },
      data: { status: "DISMISSED" },
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reorder.dismissed",
        entityType: "ReorderSuggestion",
        entityId: "s-1",
        afterJson: { status: "DISMISSED" },
      }),
    );
    // Single-statement mutation — no transaction needed.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("errors when the suggestion is already handled or cross-org", async () => {
    mocks.suggestionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(dismissSuggestion(ORG, "user-1", "s-1")).rejects.toThrow(
      ReorderSuggestionNotFoundError,
    );
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
