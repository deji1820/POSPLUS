/**
 * Nightly reorder-point recalculation (SPEC.md §12, issue #33).
 *
 * The §12 formula needs sales velocity, supplier lead time, and a safety
 * stock window. Sales velocity is computed from the immutable movement
 * ledger (#16): net SALE + REFUND outflow over a fixed lookback window per
 * warehouse × variant. Lead time has no variant → supplier mapping yet
 * (purchasing lands later), so a documented org-wide default is used and
 * every input is recorded on the suggestion row — §12 requires the UI to
 * show the inputs used for each suggestion, and `reason` carries them.
 *
 * The job is the designated writer of `InventoryBalance.reorderPoint` /
 * `targetStock` (#16's read model renders them when set, but nothing else
 * computes them). It also upserts one PENDING `ReorderSuggestion` per
 * warehouse × variant that is below its reorder point, so operators see a
 * bounded, current suggestion list instead of an ever-growing history.
 *
 * Everything is Decimal-exact and org-scoped.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

/** Rolling window the average daily sale is computed over. */
export const REORDER_LOOKBACK_DAYS = 30;
/** Default lead time until a variant → supplier mapping exists (days). */
export const DEFAULT_LEAD_TIME_DAYS = 7;
/** Safety-stock window applied on top of lead time (§12, days). */
export const SAFETY_STOCK_DAYS = 7;
/** Target stock covers this many reorder-point cycles (order-up-to level). */
export const TARGET_STOCK_CYCLES = 2;

export interface ReorderRecalcSummary {
  organizations: number;
  balances: number;
  updated: number;
  suggested: number;
}

interface BalanceRow {
  id: string;
  organizationId: string;
  warehouseId: string;
  variantId: string;
  onHand: Prisma.Decimal;
}

function dec(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Net sales outflow (SALE is negative, REFUND positive) grouped per
 * warehouse × variant over the lookback window.
 */
async function netSalesByBalance(
  organizationId: string,
  since: Date,
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await prisma.inventoryMovement.groupBy({
    by: ["warehouseId", "variantId"],
    where: {
      organizationId,
      type: { in: ["SALE", "REFUND"] },
      createdAt: { gte: since },
    },
    _sum: { quantityDelta: true },
  });
  const map = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const key = `${row.warehouseId}:${row.variantId}`;
    map.set(key, dec(row._sum.quantityDelta ?? 0).neg()); // outflow is positive
  }
  return map;
}

/**
 * Open (approved, not yet fully received) order quantity per
 * warehouse × variant, for the suggested-qty formula's onOrder term.
 */
async function onOrderByBalance(organizationId: string): Promise<Map<string, Prisma.Decimal>> {
  const lines = await prisma.purchaseOrderLine.findMany({
    where: {
      organizationId,
      purchaseOrder: { status: "APPROVED" },
    },
    select: {
      variantId: true,
      quantity: true,
      receivedQuantity: true,
      purchaseOrder: { select: { destinationWarehouseId: true } },
    },
  });
  const map = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    const open = dec(line.quantity).minus(dec(line.receivedQuantity));
    if (open.lte(0)) continue;
    const key = `${line.purchaseOrder.destinationWarehouseId}:${line.variantId}`;
    map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).plus(open));
  }
  return map;
}

async function recalculateForOrganization(
  organizationId: string,
  now: Date,
  summary: ReorderRecalcSummary,
): Promise<void> {
  const since = new Date(now.getTime() - REORDER_LOOKBACK_DAYS * 24 * 3600 * 1000);
  const balances = (await prisma.inventoryBalance.findMany({
    where: { organizationId },
    select: { id: true, organizationId: true, warehouseId: true, variantId: true, onHand: true },
  })) as BalanceRow[];
  summary.balances += balances.length;
  if (balances.length === 0) return;

  const sales = await netSalesByBalance(organizationId, since);
  const onOrder = await onOrderByBalance(organizationId);

  for (const balance of balances) {
    const key = `${balance.warehouseId}:${balance.variantId}`;
    const netOutflow = sales.get(key) ?? new Prisma.Decimal(0);
    const averageDailySales = netOutflow.div(REORDER_LOOKBACK_DAYS);
    const reorderPoint = averageDailySales.times(DEFAULT_LEAD_TIME_DAYS + SAFETY_STOCK_DAYS);
    const targetStock = reorderPoint.times(TARGET_STOCK_CYCLES);

    await prisma.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        reorderPoint,
        targetStock,
      },
    });
    summary.updated += 1;

    const openOnOrder = onOrder.get(key) ?? new Prisma.Decimal(0);
    const suggestedQty = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      targetStock.minus(dec(balance.onHand)).minus(openOnOrder),
    );
    if (suggestedQty.lte(0)) continue;

    // §12: the UI must show the inputs used for each suggestion.
    const reason = {
      lookbackDays: REORDER_LOOKBACK_DAYS,
      averageDailySales: averageDailySales.toDecimalPlaces(3).toString(),
      leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
      safetyStockDays: SAFETY_STOCK_DAYS,
      reorderPoint: reorderPoint.toDecimalPlaces(3).toString(),
      targetStock: targetStock.toDecimalPlaces(3).toString(),
      onHand: dec(balance.onHand).toString(),
      onOrder: openOnOrder.toString(),
      computedAt: now.toISOString(),
    } satisfies Prisma.InputJsonValue;

    const existing = await prisma.reorderSuggestion.findFirst({
      where: {
        organizationId,
        variantId: balance.variantId,
        warehouseId: balance.warehouseId,
        status: "PENDING",
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.reorderSuggestion.update({
        where: { id: existing.id },
        data: {
          averageDailySales,
          leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
          safetyStockDays: SAFETY_STOCK_DAYS,
          reorderPoint,
          suggestedQty,
          reason,
        },
      });
    } else {
      await prisma.reorderSuggestion.create({
        data: {
          organizationId,
          warehouseId: balance.warehouseId,
          variantId: balance.variantId,
          averageDailySales,
          leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
          safetyStockDays: SAFETY_STOCK_DAYS,
          reorderPoint,
          suggestedQty,
          reason,
        },
      });
    }
    summary.suggested += 1;
  }
}

/** Recalculate reorder points + suggestions for every organization. */
export async function recalculateReorderPoints(now: Date = new Date()): Promise<ReorderRecalcSummary> {
  const summary: ReorderRecalcSummary = {
    organizations: 0,
    balances: 0,
    updated: 0,
    suggested: 0,
  };
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    summary.organizations += 1;
    await recalculateForOrganization(org.id, now, summary);
  }
  return summary;
}
