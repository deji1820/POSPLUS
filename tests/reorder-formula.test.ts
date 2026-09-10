/**
 * Reorder-point formula (issue #17, SPEC.md §12).
 *
 * Pure-function coverage of the math the nightly job and the UI share:
 * velocity → demand during lead time + safety stock → reorder point, and
 * the suggested order quantity clamped at zero against target/onHand/onOrder.
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  computeReorderSuggestion,
  DEFAULT_TARGET_STOCK_CYCLES,
} from "@/lib/reorder/formula";

const D = (v: number | string) => new Prisma.Decimal(v);

describe("computeReorderSuggestion", () => {
  it("applies the §12 formula end to end", () => {
    const result = computeReorderSuggestion({
      unitsSold: D(60), // 2/day over 30 days
      lookbackDays: 30,
      leadTimeDays: 7,
      safetyStockDays: 7,
      onHand: D(10),
      onOrder: D(6),
    });

    expect(result.averageDailySales.toString()).toBe("2");
    expect(result.demandDuringLeadTime.toString()).toBe("14");
    expect(result.safetyStock.toString()).toBe("14");
    expect(result.reorderPoint.toString()).toBe("28");
    // Target stock defaults to 2 reorder-point cycles.
    expect(result.targetStock.toString()).toBe("56");
    expect(result.suggestedOrderQty.toString()).toBe("40");
  });

  it("defaults to two target-stock cycles", () => {
    expect(DEFAULT_TARGET_STOCK_CYCLES).toBe(2);
  });

  it("honors a custom target-stock cycle count", () => {
    const result = computeReorderSuggestion({
      unitsSold: D(30),
      lookbackDays: 30,
      leadTimeDays: 7,
      safetyStockDays: 7,
      onHand: D(0),
      onOrder: D(0),
      targetStockCycles: 3,
    });
    // velocity 1 → ROP 14 → target 3 × 14 = 42.
    expect(result.targetStock.toString()).toBe("42");
    expect(result.suggestedOrderQty.toString()).toBe("42");
  });

  it("clamps the suggested quantity at zero when coverage exceeds target", () => {
    const result = computeReorderSuggestion({
      unitsSold: D(0),
      lookbackDays: 30,
      leadTimeDays: 7,
      safetyStockDays: 7,
      onHand: D(50),
      onOrder: D(10),
    });
    expect(result.reorderPoint.toString()).toBe("0");
    expect(result.suggestedOrderQty.toString()).toBe("0");
  });

  it("subtracts both on-hand and on-order from the target", () => {
    const result = computeReorderSuggestion({
      unitsSold: D(90), // 3/day
      lookbackDays: 30,
      leadTimeDays: 7,
      safetyStockDays: 7,
      onHand: D(20),
      onOrder: D(15.5),
    });
    // ROP = 3×14 = 42, target 84, qty = 84 − 20 − 15.5 = 48.5.
    expect(result.reorderPoint.toString()).toBe("42");
    expect(result.suggestedOrderQty.toString()).toBe("48.5");
  });

  it("handles fractional velocity from partial-lookback sales", () => {
    const result = computeReorderSuggestion({
      unitsSold: D(7), // 7 units in 30 days
      lookbackDays: 30,
      leadTimeDays: 7,
      safetyStockDays: 7,
      onHand: D(0),
      onOrder: D(0),
    });
    expect(result.averageDailySales.toFixed(3)).toBe("0.233");
    // ROP = 0.2333… × 14 = 3.2666…; qty = 2 × ROP.
    expect(result.suggestedOrderQty.toFixed(3)).toBe("6.533");
  });
});
