/**
 * Journal read + reversal use-cases (SPEC.md §6 "/finance/ledger", §8
 * accounting invariants, §19 envelope-safe errors).
 *
 * Read model: the ledger is append-only. Posted entries expose NO mutation
 * surface here — the only write is `reverseEntry`, which creates a NEW
 * linked entry that mirrors the original's lines with debit/credit swapped
 * (§8: "Reversals create new entries linked to the original"; never
 * hard-delete posted entries).
 *
 * Org scoping: every query is keyed on the caller's organization; a missing
 * entry surfaces as 404 NOT_FOUND, which also makes a cross-tenant id
 * indistinguishable from a nonexistent one.
 */
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export const JOURNAL_SOURCE_TYPES = ["receipt", "refund", "reversal", "manual"] as const;
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

export const journalFilterSchema = z.object({
  fiscalPeriodId: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  source: z.enum(JOURNAL_SOURCE_TYPES).optional(),
});
export type JournalFilters = z.infer<typeof journalFilterSchema>;

export interface JournalEntrySummary {
  id: string;
  entryNumber: string | null;
  description: string | null;
  status: string;
  postedAt: string; // ISO
  store: { id: string; name: string } | null;
  fiscalPeriod: { id: string; name: string } | null;
  sourceType: JournalSourceType;
  loyverseReceiptId: string | null;
  loyverseRefundId: string | null;
  paymentType: string | null;
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  reversalOfId: string | null;
  reversedById: string | null;
}

export interface JournalLineItem {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  memo: string | null;
}

export interface JournalEntryDetail extends JournalEntrySummary {
  sourceLink: {
    loyverseReceiptId: string | null;
    loyverseRefundId: string | null;
    paymentType: string | null;
    sourceTotal: string | null;
    postedAt: string;
    store: { id: string; name: string } | null;
  } | null;
  lines: JournalLineItem[];
}

type EntryWithLines = {
  id: string;
  entryNumber: string | null;
  description: string | null;
  status: string;
  postedAt: Date;
  store: { id: string; name: string } | null;
  fiscalPeriod: { id: string; name: string } | null;
  reversalOfId: string | null;
  reversedBy: { id: string } | null;
  sourceLink: {
    loyverseReceiptId: string | null;
    loyverseRefundId: string | null;
    paymentType: string | null;
    sourceTotal: unknown;
    postedAt: Date;
  } | null;
  lines: { debit: unknown; credit: unknown }[];
};

/** Derive the filterable source type the same way everywhere. */
function sourceTypeOf(entry: Pick<EntryWithLines, "reversalOfId" | "sourceLink">): JournalSourceType {
  if (entry.reversalOfId) return "reversal";
  if (entry.sourceLink?.loyverseRefundId) return "refund";
  if (entry.sourceLink?.loyverseReceiptId) return "receipt";
  return "manual";
}

function toSummary(entry: EntryWithLines): JournalEntrySummary {
  // Decimal sums, never floats (§18 decimal money).
  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  for (const line of entry.lines) {
    totalDebit = totalDebit.plus(line.debit as number | string | Prisma.Decimal);
    totalCredit = totalCredit.plus(line.credit as number | string | Prisma.Decimal);
  }
  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    description: entry.description,
    status: entry.status,
    postedAt: entry.postedAt.toISOString(),
    store: entry.store,
    fiscalPeriod: entry.fiscalPeriod,
    sourceType: sourceTypeOf(entry),
    loyverseReceiptId: entry.sourceLink?.loyverseReceiptId ?? null,
    loyverseRefundId: entry.sourceLink?.loyverseRefundId ?? null,
    paymentType: entry.sourceLink?.paymentType ?? null,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    lineCount: entry.lines.length,
    reversalOfId: entry.reversalOfId,
    reversedById: entry.reversedBy?.id ?? null,
  };
}

const SUMMARY_INCLUDE = {
  store: { select: { id: true, name: true } },
  fiscalPeriod: { select: { id: true, name: true } },
  reversedBy: { select: { id: true } },
  sourceLink: {
    select: {
      loyverseReceiptId: true,
      loyverseRefundId: true,
      paymentType: true,
      sourceTotal: true,
      postedAt: true,
    },
  },
  lines: { select: { debit: true, credit: true } },
} as const;

function buildWhere(
  orgId: string,
  filters: JournalFilters,
): Record<string, unknown> {
  const and: Record<string, unknown>[] = [{ organizationId: orgId }];
  if (filters.fiscalPeriodId) and.push({ fiscalPeriodId: filters.fiscalPeriodId });
  if (filters.storeId) and.push({ storeId: filters.storeId });
  if (filters.accountId) and.push({ lines: { some: { accountId: filters.accountId } } });
  switch (filters.source) {
    case "receipt":
      and.push({
        sourceLink: { is: { loyverseReceiptId: { not: null }, loyverseRefundId: null } },
      });
      break;
    case "refund":
      and.push({ sourceLink: { is: { loyverseRefundId: { not: null } } } });
      break;
    case "reversal":
      and.push({ reversalOfId: { not: null } });
      break;
    case "manual":
      and.push({
        AND: [{ sourceLink: { is: null } }, { reversalOfId: null }],
      });
      break;
  }
  return { AND: and };
}

/** Filtered journal-entry list, newest first (§6 "filtering: period, store, account, source type"). */
export async function listJournalEntries(
  orgId: string,
  rawFilters: unknown,
): Promise<JournalEntrySummary[]> {
  const filters = journalFilterSchema.safeParse(rawFilters ?? {});
  if (!filters.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Invalid journal filter parameters.");
  }
  const entries = await prisma.journalEntry.findMany({
    where: buildWhere(orgId, filters.data) as never,
    include: SUMMARY_INCLUDE,
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
  });
  return entries.map((entry) => toSummary(entry as unknown as EntryWithLines));
}

/** Entry detail with account lines. 404 doubles as the cross-tenant guard. */
export async function getJournalEntry(orgId: string, entryId: string): Promise<JournalEntryDetail> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: entryId, organizationId: orgId },
    include: {
      ...SUMMARY_INCLUDE,
      lines: {
        select: {
          id: true,
          accountId: true,
          debit: true,
          credit: true,
          memo: true,
          account: { select: { code: true, name: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!entry) {
    throw new FinanceError(404, "NOT_FOUND", "Journal entry not found.");
  }
  const summary = toSummary(entry as unknown as EntryWithLines);
  const link = entry.sourceLink;
  return {
    ...summary,
    sourceLink: link
      ? {
          loyverseReceiptId: link.loyverseReceiptId,
          loyverseRefundId: link.loyverseRefundId,
          paymentType: link.paymentType,
          sourceTotal: link.sourceTotal === null || link.sourceTotal === undefined ? null : String(link.sourceTotal),
          postedAt: link.postedAt.toISOString(),
          store: summary.store,
        }
      : null,
    lines: (
      entry.lines as {
        id: string;
        accountId: string;
        debit: unknown;
        credit: unknown;
        memo: string | null;
        account: { code: string; name: string };
      }[]
    ).map((line) => ({
      id: line.id,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      debit: Number(line.debit).toFixed(2),
      credit: Number(line.credit).toFixed(2),
      memo: line.memo,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reversal (§8: reversals create new entries linked to the original)
// ---------------------------------------------------------------------------

export const reverseEntrySchema = z.object({
  reason: z.string().trim().min(1, "A reversal reason is required.").max(500),
});
export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;

export interface ReversalResult {
  reversalEntryId: string;
}

/**
 * Reverse a posted entry: creates a new POSTED entry whose lines mirror the
 * original with debit/credit swapped, linked via `reversalOfId`
 * (one reversal per original — the column is @unique, and a raced duplicate
 * is reported as ALREADY_REVERSED). The original entry is never mutated.
 */
export async function reverseEntry(
  orgId: string,
  entryId: string,
  raw: unknown,
  actorId?: string,
): Promise<ReversalResult> {
  const input = reverseEntrySchema.safeParse(raw);
  if (!input.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", input.error.issues[0]?.message ?? "Invalid reversal.");
  }
  const reason = input.data.reason;

  const original = await prisma.journalEntry.findFirst({
    where: { id: entryId, organizationId: orgId },
    include: {
      reversedBy: { select: { id: true } },
      lines: {
        select: { accountId: true, debit: true, credit: true, memo: true },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!original) {
    throw new FinanceError(404, "NOT_FOUND", "Journal entry not found.");
  }
  if (original.status !== "POSTED") {
    throw new FinanceError(400, "ENTRY_NOT_POSTED", "Only posted entries can be reversed.");
  }
  if (original.reversedBy) {
    throw new FinanceError(400, "ALREADY_REVERSED", "This entry has already been reversed.");
  }
  if (original.reversalOfId) {
    throw new FinanceError(400, "IS_REVERSAL", "A reversal entry cannot be reversed; reverse the original entry instead.");
  }
  if (original.lines.length === 0) {
    throw new FinanceError(500, "UNBALANCED_ENTRY", "Cannot reverse an entry with no lines.");
  }

  const description = `Reversal of ${original.description ?? original.entryNumber ?? original.id}`;
  try {
    const reversal = await prisma.$transaction(async (tx) => {
      const created = await tx.journalEntry.create({
        data: {
          organizationId: orgId,
          storeId: original.storeId,
          fiscalPeriodId: original.fiscalPeriodId,
          status: "POSTED",
          description,
          reversalOfId: original.id,
          ...(actorId ? { createdById: actorId } : {}),
          lines: {
            create: original.lines.map((line) => {
              const debit = new Prisma.Decimal(line.debit as number | string | Prisma.Decimal);
              const credit = new Prisma.Decimal(line.credit as number | string | Prisma.Decimal);
              return {
                organizationId: orgId,
                accountId: line.accountId,
                // Mirror with sides swapped; zero stays zero.
                debit: credit.toFixed(2),
                credit: debit.toFixed(2),
                memo: `Reversal of: ${line.memo ?? description}`,
              };
            }),
          },
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          actorUserId: actorId ?? null,
          action: "journal.reversed",
          entityType: "JournalEntry",
          entityId: original.id,
          metadataJson: { reason, reversalEntryId: created.id },
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: orgId,
          actorUserId: actorId ?? null,
          action: "journal.posted",
          entityType: "JournalEntry",
          entityId: created.id,
          metadataJson: { source: "reversal", reversalOfId: original.id, reason },
        },
      });
      return created;
    });
    return { reversalEntryId: reversal.id };
  } catch (error) {
    // A concurrent request reversed the same entry first: reversalOfId is
    // @unique, so the loser lands here. Report the settled state.
    if (
      typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw new FinanceError(400, "ALREADY_REVERSED", "This entry has already been reversed.");
    }
    throw error;
  }
}
