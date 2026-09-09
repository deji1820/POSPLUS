/**
 * Finance dashboard summaries (SPEC.md §6 "/finance/dashboard": cash/sales
 * summary, posted ledger summary, AP/AR aging).
 *
 * All figures are org-scoped and computed in exact Decimal arithmetic (§18).
 * Sales figures come from the Receipt/Refund tables (operational truth); the
 * ledger summary comes from posted journal lines (accounting truth); aging
 * buckets the OPEN ARInvoice/APBill balances by days past due. The P&L
 * itself is #13 — this page links there rather than duplicating it.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

export interface AgingBucket {
  label: string;
  amount: string;
  count: number;
}

export interface AgingSummary {
  openCount: number;
  totalOutstanding: string;
  buckets: AgingBucket[];
}

export interface FinanceDashboard {
  /** Current calendar month, server-local. */
  month: { start: string; label: string };
  sales: {
    receiptCount: number;
    receiptTotal: string;
    refundCount: number;
    refundTotal: string;
    netSales: string;
  };
  ledger: {
    entriesThisMonth: number;
    debitsThisMonth: string;
    totalEntries: number;
    reversedCount: number;
    lastPostedAt: string | null;
  };
  ar: AgingSummary;
  ap: AgingSummary;
}

const AGING_LABELS = ["Current", "1–30 days", "31–60 days", "61–90 days", "90+ days"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyAging(): AgingSummary {
  return {
    openCount: 0,
    totalOutstanding: "0.00",
    buckets: AGING_LABELS.map((label) => ({ label, amount: "0.00", count: 0 })),
  };
}

function bucketAging(
  rows: { balance: unknown; dueDate: Date | null; issuedAt: Date }[],
  now: Date,
): AgingSummary {
  const aging = emptyAging();
  let total = new Prisma.Decimal(0);
  for (const row of rows) {
    const balance = new Prisma.Decimal(row.balance as number | string | Prisma.Decimal);
    if (balance.lessThanOrEqualTo(0)) continue;
    aging.openCount += 1;
    total = total.plus(balance);
    // Age from due date when present, else from issue date.
    const anchor = row.dueDate ?? row.issuedAt;
    const daysPast = Math.floor((now.getTime() - anchor.getTime()) / DAY_MS);
    const idx = daysPast <= 0 ? 0 : daysPast <= 30 ? 1 : daysPast <= 60 ? 2 : daysPast <= 90 ? 3 : 4;
    const bucket = aging.buckets[idx];
    bucket.amount = new Prisma.Decimal(bucket.amount).plus(balance).toFixed(2);
    bucket.count += 1;
  }
  aging.totalOutstanding = total.toFixed(2);
  return aging;
}

function monthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function getFinanceDashboard(orgId: string): Promise<FinanceDashboard> {
  const now = new Date();
  const start = monthStart(now);

  const [receiptAgg, refundAgg, entriesThisMonth, debitAgg, totalAgg, reversedAgg, lastPosted, arRows, apRows] =
    await Promise.all([
      prisma.receipt.aggregate({
        where: { organizationId: orgId, createdAt: { gte: start } },
        _count: true,
        _sum: { total: true },
      }),
      prisma.refund.aggregate({
        where: { organizationId: orgId, createdAt: { gte: start } },
        _count: true,
        _sum: { total: true },
      }),
      prisma.journalEntry.count({
        where: { organizationId: orgId, postedAt: { gte: start } },
      }),
      prisma.journalLine.aggregate({
        where: { organizationId: orgId, journalEntry: { postedAt: { gte: start } } },
        _sum: { debit: true },
      }),
      prisma.journalEntry.count({ where: { organizationId: orgId } }),
      prisma.journalEntry.count({ where: { organizationId: orgId, reversedBy: { is: null }, reversalOfId: null } }),
      prisma.journalEntry.findFirst({
        where: { organizationId: orgId },
        orderBy: { postedAt: "desc" },
        select: { postedAt: true },
      }),
      prisma.aRInvoice.findMany({
        where: { organizationId: orgId, status: "OPEN" },
        select: { balance: true, dueDate: true, issuedAt: true },
      }),
      prisma.aPBill.findMany({
        where: { organizationId: orgId, status: "OPEN" },
        select: { balance: true, dueDate: true, issuedAt: true },
      }),
    ]);

  const receiptTotal = new Prisma.Decimal(receiptAgg._sum.total ?? 0);
  const refundTotal = new Prisma.Decimal(refundAgg._sum.total ?? 0);
  // Ledger "reversed count" = entries that are themselves reversal entries.
  const reversedCount = totalAgg - reversedAgg;

  return {
    month: {
      start: start.toISOString(),
      label: start.toLocaleString("en-US", { month: "long", year: "numeric" }),
    },
    sales: {
      receiptCount: receiptAgg._count,
      receiptTotal: receiptTotal.toFixed(2),
      refundCount: refundAgg._count,
      refundTotal: refundTotal.toFixed(2),
      netSales: receiptTotal.minus(refundTotal).toFixed(2),
    },
    ledger: {
      entriesThisMonth,
      debitsThisMonth: new Prisma.Decimal(debitAgg._sum.debit ?? 0).toFixed(2),
      totalEntries: totalAgg,
      reversedCount,
      lastPostedAt: lastPosted?.postedAt.toISOString() ?? null,
    },
    ar: bucketAging(arRows, now),
    ap: bucketAging(apRows, now),
  };
}
