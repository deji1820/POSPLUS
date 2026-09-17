/**
 * Nightly reconciliation checks (SPEC.md §10, issue #33).
 *
 * Cross-checks the two accounting-truth invariants the system relies on and
 * flags each organization where they do not hold:
 *
 *   - Inventory: every `InventoryBalance.onHand` must equal Σ
 *     `InventoryMovement.quantityDelta` for its warehouse × variant (#16
 *     writes the pair atomically, so a mismatch means a hand-edited row or
 *     a bug — either way the operator must know);
 *   - Journal: every POSTED `JournalEntry` must have Σ debit = Σ credit
 *     (§11 balanced entries are the foundation the ledger/P&L read).
 *
 * Findings are recorded as org-scoped audit rows (§17, system actor) with
 * counts — not row dumps — and the job itself SUCCEEDS either way: a
 * reconciliation finding is data for the operator, not a job failure.
 */
import { Prisma } from "@prisma/client";

import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { prisma } from "@/lib/db";

export interface ReconciliationSummary {
  organizations: number;
  inventoryMismatches: number;
  unbalancedEntries: number;
  flaggedOrganizations: number;
}

function dec(value: Prisma.Decimal | number): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

async function checkOrganization(
  organizationId: string,
  summary: ReconciliationSummary,
): Promise<void> {
  const movementSums = await prisma.inventoryMovement.groupBy({
    by: ["warehouseId", "variantId"],
    where: { organizationId },
    _sum: { quantityDelta: true },
  });
  const movementMap = new Map<string, Prisma.Decimal>();
  for (const row of movementSums) {
    movementMap.set(
      `${row.warehouseId}:${row.variantId}`,
      dec(row._sum.quantityDelta ?? 0),
    );
  }
  const balances = await prisma.inventoryBalance.findMany({
    where: { organizationId },
    select: { warehouseId: true, variantId: true, onHand: true },
  });
  let inventoryMismatches = 0;
  for (const balance of balances) {
    const moved = movementMap.get(`${balance.warehouseId}:${balance.variantId}`);
    // A balance with no movements must be at zero; otherwise compare sums.
    const expected = moved ?? new Prisma.Decimal(0);
    if (!dec(balance.onHand).equals(expected)) inventoryMismatches += 1;
  }

  const lineSums = await prisma.journalLine.groupBy({
    by: ["journalEntryId"],
    where: { organizationId, journalEntry: { status: "POSTED" } },
    _sum: { debit: true, credit: true },
  });
  let unbalancedEntries = 0;
  for (const row of lineSums) {
    if (!dec(row._sum.debit ?? 0).equals(dec(row._sum.credit ?? 0))) {
      unbalancedEntries += 1;
    }
  }

  summary.inventoryMismatches += inventoryMismatches;
  summary.unbalancedEntries += unbalancedEntries;

  if (inventoryMismatches > 0 || unbalancedEntries > 0) {
    await writeAudit({
      organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.MAINTENANCE.RECONCILIATION_MISMATCH,
      entityType: "Organization",
      entityId: organizationId,
      metadataJson: {
        inventoryMismatches,
        unbalancedEntries,
      },
    });
    summary.flaggedOrganizations += 1;
  }
}

/** Run both reconciliation checks for every organization. */
export async function runReconciliationChecks(): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    organizations: 0,
    inventoryMismatches: 0,
    unbalancedEntries: 0,
    flaggedOrganizations: 0,
  };
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    summary.organizations += 1;
    await checkOrganization(org.id, summary);
  }
  return summary;
}
