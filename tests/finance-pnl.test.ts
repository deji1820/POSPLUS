/**
 * P&L report use-case (SPEC.md §11 "P&L minimums", §8 accounting invariants,
 * issue #13).
 *
 * The statement is computed from POSTED journal lines, so it balances against
 * the ledger by construction; the revenue buckets (sales / refunds /
 * adjustments) must sum exactly to the net of all revenue lines. When no
 * COGS lines are posted in the period, cost data is incomplete and the gross
 * profit / net result KPIs are labeled (null) rather than implying a false
 * precision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FinanceError } from "@/lib/finance/errors";
import { getPnlReport } from "@/lib/finance/pnl";

const mocks = vi.hoisted(() => ({
  journalLineFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    journalLine: { findMany: mocks.journalLineFindMany },
  },
}));

const SALES = { id: "acc-4000", code: "4000", name: "Sales Revenue", type: "REVENUE" };
const COGS = { id: "acc-5000", code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" };
const OPEX = { id: "acc-6000", code: "6000", name: "Operating Expenses", type: "EXPENSE" };

function receiptLine(account: typeof SALES, credit: string, debit = "0.00") {
  return {
    debit,
    credit,
    account,
    journalEntry: {
      reversalOfId: null,
      sourceLink: { loyverseReceiptId: "lv-r1", loyverseRefundId: null },
    },
  };
}

function refundLine(account: typeof SALES, debit: string) {
  return {
    debit,
    credit: "0.00",
    account,
    journalEntry: {
      reversalOfId: null,
      sourceLink: { loyverseReceiptId: "lv-r1", loyverseRefundId: "lv-f1" },
    },
  };
}

function manualLine(account: typeof SALES | typeof COGS | typeof OPEX, debit: string, credit = "0.00") {
  return {
    debit,
    credit,
    account,
    journalEntry: { reversalOfId: null, sourceLink: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.journalLineFindMany.mockResolvedValue([]);
});

describe("getPnlReport", () => {
  it("classifies receipt credits as sales and refund debits as contra-revenue", async () => {
    mocks.journalLineFindMany.mockResolvedValue([
      receiptLine(SALES, "100.00"),
      refundLine(SALES, "20.00"),
      manualLine(OPEX, "15.00"),
    ]);
    const report = await getPnlReport("org-1", {
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(report.consolidated).toBe(true);
    expect(report.period.sales).toBe("100.00");
    expect(report.period.refunds).toBe("-20.00");
    expect(report.period.adjustments).toBe("0.00");
    expect(report.period.netRevenue).toBe("80.00");
    expect(report.period.balances).toBe(true);
  });

  it("groups operating expenses per account and excludes COGS from opex", async () => {
    mocks.journalLineFindMany.mockResolvedValue([
      receiptLine(SALES, "200.00"),
      manualLine(COGS, "50.00"),
      manualLine(OPEX, "10.00"),
      manualLine({ ...OPEX, id: "acc-6100", code: "6100", name: "Labor Cost" }, "30.00"),
    ]);
    const report = await getPnlReport("org-1", { from: "2026-09-01", to: "2026-09-30" });
    expect(report.period.cogs).toBe("-50.00");
    expect(report.period.costDataComplete).toBe(true);
    expect(report.period.grossProfit).toBe("150.00");
    expect(report.period.operatingExpenses).toHaveLength(2);
    expect(report.period.operatingExpenses[0]).toMatchObject({ code: "6000", amount: "-10.00" });
    expect(report.period.operatingExpenses[1]).toMatchObject({ code: "6100", amount: "-30.00" });
    expect(report.period.totalOperatingExpenses).toBe("-40.00");
    expect(report.period.netResult).toBe("110.00");
  });

  it("labels gross profit and net result when cost data is incomplete", async () => {
    mocks.journalLineFindMany.mockResolvedValue([receiptLine(SALES, "100.00"), manualLine(OPEX, "5.00")]);
    const report = await getPnlReport("org-1", { from: "2026-09-01", to: "2026-09-30" });
    expect(report.period.costDataComplete).toBe(false);
    expect(report.period.grossProfit).toBeNull();
    expect(report.period.netResult).toBeNull();
    expect(report.costLabel.length).toBeGreaterThan(0);
  });

  it("buckets reversal and manual revenue lines into adjustments so lines sum exactly", async () => {
    mocks.journalLineFindMany.mockResolvedValue([
      receiptLine(SALES, "100.00"),
      {
        debit: "0.00",
        credit: "5.00",
        account: SALES,
        journalEntry: { reversalOfId: "je-9", sourceLink: null },
      },
      manualLine(SALES, "0.00", "2.00"),
    ]);
    const report = await getPnlReport("org-1", { from: "2026-09-01", to: "2026-09-30" });
    expect(report.period.sales).toBe("100.00");
    expect(report.period.adjustments).toBe("7.00");
    expect(report.period.netRevenue).toBe("107.00");
    expect(report.period.balances).toBe(true);
  });

  it("computes the preceding equal-length period when compare is requested", async () => {
    mocks.journalLineFindMany
      .mockResolvedValueOnce([receiptLine(SALES, "90.00")])
      .mockResolvedValueOnce([receiptLine(SALES, "60.00")]);
    const report = await getPnlReport("org-1", {
      from: "2026-09-01",
      to: "2026-09-30",
      compare: "1",
    });
    expect(mocks.journalLineFindMany).toHaveBeenCalledTimes(2);
    expect(report.period.sales).toBe("90.00");
    expect(report.comparison).not.toBeNull();
    expect(report.comparison!.sales).toBe("60.00");
    const firstCall = mocks.journalLineFindMany.mock.calls[0][0] as {
      where: { journalEntry: { postedAt: { gte: Date; lte: Date } } };
    };
    const secondCall = mocks.journalLineFindMany.mock.calls[1][0] as {
      where: { journalEntry: { postedAt: { gte: Date; lte: Date } } };
    };
    const firstLength =
      firstCall.where.journalEntry.postedAt.lte.getTime() - firstCall.where.journalEntry.postedAt.gte.getTime();
    const secondLength =
      secondCall.where.journalEntry.postedAt.lte.getTime() - secondCall.where.journalEntry.postedAt.gte.getTime();
    // Inclusive end date makes the comparison span one ms shorter in
    // arithmetic, but it covers the same equal-length date range.
    expect(Math.abs(secondLength - firstLength)).toBeLessThanOrEqual(1);
    expect(secondCall.where.journalEntry.postedAt.lte.getTime()).toBeLessThan(
      firstCall.where.journalEntry.postedAt.gte.getTime(),
    );
  });

  it("scopes the store filter on the journal entry", async () => {
    await getPnlReport("org-1", { from: "2026-09-01", to: "2026-09-30", storeId: "store-1" });
    const call = mocks.journalLineFindMany.mock.calls[0][0] as {
      where: { journalEntry: { storeId?: string } };
    };
    expect(call.where.journalEntry.storeId).toBe("store-1");
    const consolidated = await getPnlReport("org-1", { from: "2026-09-01", to: "2026-09-30" });
    expect(mocks.journalLineFindMany).toHaveBeenCalledTimes(2);
    const consolidatedCall = mocks.journalLineFindMany.mock.calls[1][0] as {
      where: { journalEntry: { storeId?: string } };
    };
    expect(consolidatedCall.where.journalEntry.storeId).toBeUndefined();
    expect(consolidated.consolidated).toBe(true);
  });

  it("filters to POSTED entries only and validates bad input", async () => {
    await getPnlReport("org-1", {});
    const call = mocks.journalLineFindMany.mock.calls[0][0] as {
      where: { journalEntry: { status: string } };
    };
    expect(call.where.journalEntry.status).toBe("POSTED");
    await expect(getPnlReport("org-1", { from: "not-a-date" })).rejects.toBeInstanceOf(FinanceError);
    await expect(
      getPnlReport("org-1", { from: "2026-09-30", to: "2026-09-01" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
