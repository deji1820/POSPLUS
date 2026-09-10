/**
 * Nightly reconciliation checks (issue #33, SPEC.md §10).
 *
 * - every balance equals Σ movements for its warehouse × variant;
 * - every POSTED journal entry has Σ debit = Σ credit;
 * - findings produce one audit row per org with counts; a clean org is
 *   silent and the summary reports zero mismatches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import { runReconciliationChecks } from "@/lib/maintenance/reconciliation";

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  organizationFindMany: vi.fn(),
  inventoryMovementGroupBy: vi.fn(),
  inventoryBalanceFindMany: vi.fn(),
  journalLineGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: { findMany: mocks.organizationFindMany },
    inventoryMovement: { groupBy: mocks.inventoryMovementGroupBy },
    inventoryBalance: { findMany: mocks.inventoryBalanceFindMany },
    journalLine: { groupBy: mocks.journalLineGroupBy },
  },
}));

vi.mock("@/lib/audit/writer", () => ({
  AUDIT_ACTIONS: {
    MAINTENANCE: {
      STALE_SYNC_RUN: "maintenance.stale_sync_run",
      STALE_WEBHOOK: "maintenance.stale_webhook",
      RECONCILIATION_MISMATCH: "maintenance.reconciliation_mismatch",
    },
  },
  writeAudit: mocks.writeAudit,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }]);
  mocks.inventoryMovementGroupBy.mockResolvedValue([]);
  mocks.inventoryBalanceFindMany.mockResolvedValue([]);
  mocks.journalLineGroupBy.mockResolvedValue([]);
  mocks.writeAudit.mockResolvedValue(undefined);
});

describe("runReconciliationChecks", () => {
  it("is silent when movements reconcile to balances and the journal balances", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", onHand: new Prisma.Decimal("5.000") },
    ]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal("5.000") } },
    ]);
    mocks.journalLineGroupBy.mockResolvedValue([
      { journalEntryId: "je-1", _sum: { debit: new Prisma.Decimal("100.00"), credit: new Prisma.Decimal("100.00") } },
    ]);

    const summary = await runReconciliationChecks();

    expect(summary).toMatchObject({
      organizations: 1,
      inventoryMismatches: 0,
      unbalancedEntries: 0,
      flaggedOrganizations: 0,
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("flags an inventory balance that does not equal Σ movements", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", onHand: new Prisma.Decimal("4.000") },
    ]);
    mocks.inventoryMovementGroupBy.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", _sum: { quantityDelta: new Prisma.Decimal("5.000") } },
    ]);

    const summary = await runReconciliationChecks();

    expect(summary.inventoryMismatches).toBe(1);
    expect(summary.flaggedOrganizations).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        actorUserId: null,
        action: "maintenance.reconciliation_mismatch",
        metadataJson: { inventoryMismatches: 1, unbalancedEntries: 0 },
      }),
    );
  });

  it("flags a balance with movements but no movement rows as a mismatch only when non-zero", async () => {
    // Zero on-hand with zero movements is consistent (never-stocked row).
    mocks.inventoryBalanceFindMany.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", onHand: new Prisma.Decimal("0") },
    ]);

    const clean = await runReconciliationChecks();
    expect(clean.inventoryMismatches).toBe(0);

    mocks.inventoryBalanceFindMany.mockResolvedValue([
      { warehouseId: "wh-1", variantId: "var-1", onHand: new Prisma.Decimal("2") },
    ]);
    const mismatch = await runReconciliationChecks();
    expect(mismatch.inventoryMismatches).toBe(1);
  });

  it("flags a POSTED journal entry whose debits do not equal its credits", async () => {
    mocks.journalLineGroupBy.mockResolvedValue([
      { journalEntryId: "je-bad", _sum: { debit: new Prisma.Decimal("100.00"), credit: new Prisma.Decimal("90.00") } },
      { journalEntryId: "je-ok", _sum: { debit: new Prisma.Decimal("50.00"), credit: new Prisma.Decimal("50.00") } },
    ]);

    const summary = await runReconciliationChecks();

    expect(summary.unbalancedEntries).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataJson: { inventoryMismatches: 0, unbalancedEntries: 1 },
      }),
    );
    // The POSTED-only filter is applied in the query, not in memory.
    expect(mocks.journalLineGroupBy.mock.calls[0][0].where.journalEntry.status).toBe("POSTED");
  });
});
