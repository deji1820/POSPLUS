/**
 * P&L report (SPEC.md §11 "P&L minimums", issue #13).
 *
 * The statement is computed from POSTED journal lines only, so it balances
 * against the ledger by construction (acceptance: "P&L balances against
 * posted journal entries for a seeded period"). Presentation buckets:
 *
 *   - Sales:            net (credit − debit) of REVENUE-account lines on
 *                       receipt-source entries.
 *   - Refunds (contra): net of REVENUE-account lines on refund-source
 *                       entries (negative; shown as a contra-revenue row).
 *   - Adjustments:      every other REVENUE-account line (reversals, manual
 *                       entries) — so sales + refunds + adjustments equals
 *                       the exact net of all revenue lines.
 *   - COGS:             net of the Cost of Goods Sold account (code 5000).
 *                       When NO cost lines are posted in the period, cost
 *                       data is incomplete (§11: "label the KPI rather than
 *                       presenting an implied false precision") — gross
 *                       profit and net result are then returned as null
 *                       with `costDataComplete: false` instead of implying
 *                       a false 100 % margin.
 *   - Operating expenses: remaining EXPENSE accounts, grouped per account.
 *
 * Periods are postedAt date ranges; store filter is journalEntry.storeId;
 * omitting the store gives the consolidated view. All money is Prisma.Decimal
 * (§18 decimal money) and serialized as fixed-2 strings.
 */
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

/** Baseline COGS account (lib/finance/baseline.ts). */
export const COGS_ACCOUNT_CODE = "5000";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const pnlFilterSchema = z.object({
  storeId: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  compare: z
    .union([z.literal("1"), z.literal("true"), z.literal(true), z.literal("0"), z.literal("false"), z.literal(false)])
    .optional(),
});
export type PnlFilters = z.infer<typeof pnlFilterSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PnlAccountRow {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

export interface PnlPeriod {
  from: string; // ISO
  to: string; // ISO
  sales: string;
  refunds: string; // negative (contra-revenue)
  adjustments: string;
  netRevenue: string;
  /** Signed like the other lines: debit-posted cost is negative. */
  cogs: string;
  costDataComplete: boolean;
  /** null when cost data is incomplete — labeled instead of implied (§11). */
  grossProfit: string | null;
  operatingExpenses: PnlAccountRow[];
  /** Signed: debit-posted expenses are negative. */
  totalOperatingExpenses: string;
  /** null when cost data is incomplete (result before COGS would mislead). */
  netResult: string | null;
  /** true when revenue lines net exactly to sales+refunds+adjustments. */
  balances: boolean;
}

export interface PnlReport {
  storeId: string | null;
  consolidated: boolean;
  costLabel: string;
  period: PnlPeriod;
  comparison: PnlPeriod | null;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

type PnlLineRow = {
  debit: unknown;
  credit: unknown;
  account: { id: string; code: string; name: string; type: string };
  journalEntry: {
    reversalOfId: string | null;
    sourceLink: { loyverseReceiptId: string | null; loyverseRefundId: string | null } | null;
  };
};

function d(value: unknown): Prisma.Decimal {
  return new Prisma.Decimal(value as number | string | Prisma.Decimal);
}

async function loadLines(orgId: string, from: Date, to: Date, storeId?: string): Promise<PnlLineRow[]> {
  return (await prisma.journalLine.findMany({
    where: {
      organizationId: orgId,
      journalEntry: {
        status: "POSTED",
        postedAt: { gte: from, lte: to },
        ...(storeId ? { storeId } : {}),
      },
    },
    select: {
      debit: true,
      credit: true,
      account: { select: { id: true, code: true, name: true, type: true } },
      journalEntry: {
        select: {
          reversalOfId: true,
          sourceLink: { select: { loyverseReceiptId: true, loyverseRefundId: true } },
        },
      },
    },
  })) as unknown as PnlLineRow[];
}

function computePeriod(lines: PnlLineRow[], from: Date, to: Date): PnlPeriod {
  let sales = new Prisma.Decimal(0);
  let refunds = new Prisma.Decimal(0);
  let adjustments = new Prisma.Decimal(0);
  let revenueNet = new Prisma.Decimal(0);
  let cogs = new Prisma.Decimal(0);
  let cogsLineCount = 0;
  const opexByAccount = new Map<string, PnlAccountRow & { total: Prisma.Decimal }>();

  for (const line of lines) {
    const net = d(line.credit).minus(d(line.debit));
    if (line.account.type === "REVENUE") {
      revenueNet = revenueNet.plus(net);
      const entry = line.journalEntry;
      if (entry.reversalOfId) {
        adjustments = adjustments.plus(net);
      } else if (entry.sourceLink?.loyverseRefundId) {
        refunds = refunds.plus(net);
      } else if (entry.sourceLink?.loyverseReceiptId) {
        sales = sales.plus(net);
      } else {
        adjustments = adjustments.plus(net);
      }
    } else if (line.account.type === "EXPENSE") {
      if (line.account.code === COGS_ACCOUNT_CODE) {
        cogs = cogs.plus(net); // expense: debit-positive net
        cogsLineCount += 1;
      } else {
        const row = opexByAccount.get(line.account.id);
        if (row) {
          row.total = row.total.plus(net);
        } else {
          opexByAccount.set(line.account.id, {
            accountId: line.account.id,
            code: line.account.code,
            name: line.account.name,
            amount: "",
            total: net,
          });
        }
      }
    }
  }

  const costDataComplete = cogsLineCount > 0;
  let totalOpex = new Prisma.Decimal(0);
  const operatingExpenses = [...opexByAccount.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((row) => {
      totalOpex = totalOpex.plus(row.total);
      return { accountId: row.accountId, code: row.code, name: row.name, amount: row.total.toFixed(2) };
    });

  const bucketedRevenue = sales.plus(refunds).plus(adjustments);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    sales: sales.toFixed(2),
    refunds: refunds.toFixed(2),
    adjustments: adjustments.toFixed(2),
    netRevenue: revenueNet.toFixed(2),
    cogs: cogs.toFixed(2),
    costDataComplete,
    grossProfit: costDataComplete ? revenueNet.plus(cogs).toFixed(2) : null,
    operatingExpenses,
    totalOperatingExpenses: totalOpex.toFixed(2),
    netResult: costDataComplete ? revenueNet.plus(cogs).plus(totalOpex).toFixed(2) : null,
    balances: revenueNet.equals(bucketedRevenue),
  };
}

function parseBoundary(raw: string | undefined, endOfDay: boolean): Date | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Build the P&L for a postedAt date range. Defaults: current calendar month
 * to now. With `compare`, also computes the immediately preceding equal-length
 * period (SPEC §6 "period comparison").
 */
export async function getPnlReport(orgId: string, rawFilters: unknown): Promise<PnlReport> {
  const parsed = pnlFilterSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Invalid P&L filter parameters.");
  }
  const filters = parsed.data;

  const now = new Date();
  const from = parseBoundary(filters.from, false) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = parseBoundary(filters.to, true) ?? now;
  if (from.getTime() > to.getTime()) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Invalid P&L filter parameters.");
  }

  const wantCompare =
    filters.compare === true || filters.compare === "1" || filters.compare === "true";
  const lengthMs = to.getTime() - from.getTime();

  const [periodLines, comparisonLines] = await Promise.all([
    loadLines(orgId, from, to, filters.storeId),
    wantCompare
      ? loadLines(orgId, new Date(from.getTime() - lengthMs), new Date(from.getTime() - 1), filters.storeId)
      : Promise.resolve([]),
  ]);

  return {
    storeId: filters.storeId ?? null,
    consolidated: !filters.storeId,
    costLabel: "Cost data unavailable — COGS not posted for this period",
    period: computePeriod(periodLines, from, to),
    comparison: wantCompare
      ? computePeriod(comparisonLines, new Date(from.getTime() - lengthMs), new Date(from.getTime() - 1))
      : null,
  };
}
