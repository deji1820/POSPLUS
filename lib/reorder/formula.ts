/**
 * Reorder-point formula (SPEC.md §12, issue #17).
 *
 * The first implementation uses sales velocity plus supplier lead time:
 *
 *   averageDailySales    = unitsSold / lookbackDays
 *   demandDuringLeadTime = averageDailySales * leadTimeDays
 *   safetyStock          = averageDailySales * safetyStockDays
 *   reorderPoint         = demandDuringLeadTime + safetyStock
 *   suggestedOrderQty    = max(0, targetStock - onHand - onOrder)
 *
 * `targetStock` is not spelled out in §12 beyond appearing in the suggested
 * quantity formula; this implementation defines it as `targetStockCycles`
 * reorder-point cycles of demand (default 2), i.e. ordering up to the
 * suggested quantity covers twice the reorder point. The nightly
 * recalculation job (issue #33) and this module share this one canonical
 * function so the UI can never disagree with the job about the math.
 *
 * Pure function over Prisma Decimals — no I/O, fully unit-testable.
 */
import { Prisma } from "@prisma/client";

/** Default coverage of the target stock, in reorder-point cycles. */
export const DEFAULT_TARGET_STOCK_CYCLES = 2;

export interface ReorderComputationInput {
  /** Net units sold (SALE minus REFUND outflow) over the lookback window. */
  unitsSold: Prisma.Decimal;
  /** Window the velocity is averaged over, in days (§12 lookbackDays). */
  lookbackDays: number;
  /** Supplier lead time in days. */
  leadTimeDays: number;
  /** Safety-stock buffer in days of demand. */
  safetyStockDays: number;
  /** Current on-hand balance at the warehouse. */
  onHand: Prisma.Decimal;
  /** Quantity already on open (approved, not fully received) POs. */
  onOrder: Prisma.Decimal;
  /** Target stock coverage in reorder-point cycles; defaults to 2. */
  targetStockCycles?: number;
}

export interface ReorderComputation {
  averageDailySales: Prisma.Decimal;
  demandDuringLeadTime: Prisma.Decimal;
  safetyStock: Prisma.Decimal;
  reorderPoint: Prisma.Decimal;
  targetStock: Prisma.Decimal;
  /** Never negative — below-target stock with open coverage yields 0. */
  suggestedOrderQty: Prisma.Decimal;
}

export function computeReorderSuggestion(
  input: ReorderComputationInput,
): ReorderComputation {
  const cycles = input.targetStockCycles ?? DEFAULT_TARGET_STOCK_CYCLES;
  const averageDailySales = input.unitsSold.div(input.lookbackDays);
  const demandDuringLeadTime = averageDailySales.mul(input.leadTimeDays);
  const safetyStock = averageDailySales.mul(input.safetyStockDays);
  const reorderPoint = demandDuringLeadTime.add(safetyStock);
  const targetStock = reorderPoint.mul(cycles);
  const suggestedOrderQty = Prisma.Decimal.max(
    0,
    targetStock.sub(input.onHand).sub(input.onOrder),
  );
  return {
    averageDailySales,
    demandDuringLeadTime,
    safetyStock,
    reorderPoint,
    targetStock,
    suggestedOrderQty,
  };
}
