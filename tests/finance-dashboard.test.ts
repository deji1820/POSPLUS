/**
 * Finance dashboard summaries (SPEC.md §6 "/finance/dashboard", issue #12).
 * Sales from the Receipt/Refund tables, posted-ledger totals from journal
 * lines, AP/AR aging buckets from OPEN invoice/bill balances. Exact Decimal
 * arithmetic (§18); org-scoped throughout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFinanceDashboard } from "@/lib/finance/dashboard";

const mocks = vi.hoisted(() => ({
  receiptAggregate: vi.fn(),
  refundAggregate: vi.fn(),
  journalEntryCount: vi.fn(),
  journalEntryFindFirst: vi.fn(),
  journalLineAggregate: vi.fn(),
  aRInvoiceFindMany: vi.fn(),
  aPBillFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    receipt: { aggregate: mocks.receiptAggregate },
    refund: { aggregate: mocks.refundAggregate },
    journalEntry: { count: mocks.journalEntryCount, findFirst: mocks.journalEntryFindFirst },
    journalLine: { aggregate: mocks.journalLineAggregate },
    aRInvoice: { findMany: mocks.aRInvoiceFindMany },
    aPBill: { findMany: mocks.aPBillFindMany },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receiptAggregate.mockResolvedValue({ _count: 3, _sum: { total: "31.50" } });
  mocks.refundAggregate.mockResolvedValue({ _count: 1, _sum: { total: "1.50" } });
  mocks.journalEntryCount.mockResolvedValue(0);
  mocks.journalEntryFindFirst.mockResolvedValue(null);
  mocks.journalLineAggregate.mockResolvedValue({ _sum: { debit: null } });
  mocks.aRInvoiceFindMany.mockResolvedValue([]);
  mocks.aPBillFindMany.mockResolvedValue([]);
});

describe("getFinanceDashboard", () => {
  it("combines sales, ledger, and aging into one org-scoped summary", async () => {
    // First count call = entries this month; second = total; third = non-reversal (for reversedCount).
    mocks.journalEntryCount.mockResolvedValueOnce(4).mockResolvedValueOnce(10).mockResolvedValueOnce(8);
    mocks.journalLineAggregate.mockResolvedValue({ _sum: { debit: "120.00" } });
    mocks.journalEntryFindFirst.mockResolvedValue({ postedAt: new Date("2026-09-08T10:00:00Z") });
    const d = await getFinanceDashboard("org-1");
    expect(d.sales).toEqual({
      receiptCount: 3,
      receiptTotal: "31.50",
      refundCount: 1,
      refundTotal: "1.50",
      netSales: "30.00",
    });
    expect(d.ledger).toMatchObject({
      entriesThisMonth: 4,
      debitsThisMonth: "120.00",
      totalEntries: 10,
      reversedCount: 2,
      lastPostedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(d.ar.totalOutstanding).toBe("0.00");
    expect(d.ap.totalOutstanding).toBe("0.00");
  });

  it("scopes every query to the caller's org", async () => {
    await getFinanceDashboard("org-1");
    for (const call of [
      mocks.receiptAggregate.mock.calls[0][0],
      mocks.refundAggregate.mock.calls[0][0],
      mocks.journalEntryCount.mock.calls[0][0],
      mocks.aRInvoiceFindMany.mock.calls[0][0],
      mocks.aPBillFindMany.mock.calls[0][0],
    ] as { where: Record<string, unknown> }[]) {
      expect(call.where.organizationId).toBe("org-1");
    }
  });

  it("buckets AR aging by days past due, falling back to issue date", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    mocks.aRInvoiceFindMany.mockResolvedValue([
      { balance: "100.00", dueDate: new Date(now + 10 * day), issuedAt: new Date(now - 400 * day) }, // not due → Current
      { balance: "50.00", dueDate: new Date(now - 5 * day), issuedAt: new Date(now - 100 * day) }, // 1–30
      { balance: "25.00", dueDate: null, issuedAt: new Date(now - 45 * day) }, // no due date → 31–60
      { balance: "10.00", dueDate: new Date(now - 75 * day), issuedAt: new Date(now - 75 * day) }, // 61–90
      { balance: "5.00", dueDate: new Date(now - 120 * day), issuedAt: new Date(now - 120 * day) }, // 90+
      { balance: "0.00", dueDate: new Date(now - 200 * day), issuedAt: new Date(now - 200 * day) }, // paid → skipped
    ]);
    const d = await getFinanceDashboard("org-1");
    expect(d.ar.openCount).toBe(5);
    expect(d.ar.totalOutstanding).toBe("190.00");
    expect(d.ar.buckets.map((b) => [b.label, b.amount, b.count])).toEqual([
      ["Current", "100.00", 1],
      ["1–30 days", "50.00", 1],
      ["31–60 days", "25.00", 1],
      ["61–90 days", "10.00", 1],
      ["90+ days", "5.00", 1],
    ]);
  });

  it("buckets AP bills the same way", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    mocks.aPBillFindMany.mockResolvedValue([
      { balance: "200.00", dueDate: new Date(now - 20 * dayMs), issuedAt: new Date(now - 30 * dayMs) },
    ]);
    const d = await getFinanceDashboard("org-1");
    expect(d.ap.totalOutstanding).toBe("200.00");
    expect(d.ap.buckets[1]).toMatchObject({ label: "1–30 days", amount: "200.00", count: 1 });
  });
});
