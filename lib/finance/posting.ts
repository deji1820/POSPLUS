/**
 * Auto-posting receipts/refunds to the ledger (SPEC.md §11, issue #11).
 *
 * On a completed receipt: one balanced journal entry — debit the GL account
 * mapped for the receipt's payment type, credit the revenue accounts mapped
 * for the sold categories (unmapped/uncategorized lines land on the default
 * revenue account, code 4000). On a refund: the mirror entry — debit revenue,
 * credit the payment account. The original receipt posting is NEVER deleted;
 * a refund is its own entry linked to the same source (§8 immutability).
 *
 * Invariants (§8), enforced in exact decimal arithmetic (Prisma.Decimal):
 *   - every posted entry has at least one debit line and one credit line
 *   - sum(debits) == sum(credits) exactly
 *   - posting runs in one DB transaction: entry + source link + audit row
 *     commit or roll back together (§18)
 *
 * Idempotency: the unique (organizationId, loyverseReceiptId) partial index on
 * LedgerSourceLink (links without a refund id) and (organizationId,
 * loyverseRefundId) (links with one) make a duplicate insert fail; a racing
 * duplicate is reported as already posted instead of double-posting. Callers
 * also enqueue with deterministic jobIds, so under normal operation the race
 * never happens.
 *
 * Configuration gaps (unmapped payment type, inactive/missing accounts) raise
 * the operator-safe FinanceError (§19) — they are permanent until an operator
 * fixes the mapping, so the processor dead-letters them with the safe message.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

const Decimal = Prisma.Decimal;

/** Baseline sales-revenue account that catches unmapped category sales. */
export const DEFAULT_REVENUE_CODE = "4000";

export interface PostingResult {
  /** false when the source was already posted (idempotent no-op). */
  posted: boolean;
  journalEntryId: string;
}

interface DraftLine {
  accountId: string;
  side: "debit" | "credit";
  amount: Prisma.Decimal;
  memo: string;
}

interface PostingConfig {
  /** paymentType → account */
  paymentAccounts: Map<string, { id: string; name: string }>;
  /** categoryId → revenue account */
  revenueAccounts: Map<string, { id: string; name: string }>;
  defaultRevenue: { id: string; name: string };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * The current mapping snapshot plus the default revenue account. Mapped
 * accounts must be ACTIVE at posting time — an account deactivated after the
 * mapping was saved blocks posting with an operator-safe message rather than
 * silently posting into a closed account.
 */
async function loadPostingConfig(orgId: string): Promise<PostingConfig> {
  const mappings = await prisma.gLMapping.findMany({
    where: { organizationId: orgId },
    select: {
      paymentType: true,
      categoryId: true,
      account: { select: { id: true, name: true, active: true } },
    },
  });
  const paymentAccounts = new Map<string, { id: string; name: string }>();
  const revenueAccounts = new Map<string, { id: string; name: string }>();
  for (const mapping of mappings) {
    if (!mapping.account.active) {
      const target = mapping.paymentType
        ? `payment type "${mapping.paymentType}"`
        : "a sales category";
      throw new FinanceError(
        400,
        "ACCOUNT_INACTIVE",
        `The GL account mapped for ${target} is inactive. Reactivate it or update the mapping under Finance - GL Mappings.`,
      );
    }
    if (mapping.paymentType) {
      paymentAccounts.set(mapping.paymentType, mapping.account);
    } else if (mapping.categoryId) {
      revenueAccounts.set(mapping.categoryId, mapping.account);
    }
  }

  const defaultAccount = await prisma.gLAccount.findFirst({
    where: { organizationId: orgId, code: DEFAULT_REVENUE_CODE },
    select: { id: true, name: true, active: true },
  });
  if (!defaultAccount) {
    throw new FinanceError(
      500,
      "MISSING_DEFAULT_ACCOUNT",
      `The default revenue account (code ${DEFAULT_REVENUE_CODE}) does not exist. Restore the baseline chart of accounts.`,
    );
  }
  if (!defaultAccount.active) {
    throw new FinanceError(
      400,
      "ACCOUNT_INACTIVE",
      `The default revenue account (${DEFAULT_REVENUE_CODE} ${defaultAccount.name}) is inactive. Reactivate it to allow posting.`,
    );
  }
  return {
    paymentAccounts,
    revenueAccounts,
    defaultRevenue: { id: defaultAccount.id, name: defaultAccount.name },
  };
}

/**
 * Group line totals by their revenue account: variant → item → category →
 * category mapping; anything unresolvable or unmapped lands on the default
 * revenue account. Returns one merged amount per account.
 */
async function resolveRevenueSplits(
  orgId: string,
  lines: Array<{ variantId: string | null; total: unknown }>,
  config: PostingConfig,
): Promise<Map<string, { name: string; amount: Prisma.Decimal }>> {
  const variantIds = [
    ...new Set(lines.map((l) => l.variantId).filter((v): v is string => !!v)),
  ];
  const variants = variantIds.length
    ? await prisma.variant.findMany({
        where: { organizationId: orgId, id: { in: variantIds } },
        select: { id: true, item: { select: { categoryId: true } } },
      })
    : [];
  const categoryByVariant = new Map(
    variants.map((v) => [v.id, v.item?.categoryId ?? null] as const),
  );

  const splits = new Map<string, { name: string; amount: Prisma.Decimal }>();
  for (const line of lines) {
    const categoryId = line.variantId
      ? (categoryByVariant.get(line.variantId) ?? null)
      : null;
    const mapped = categoryId ? config.revenueAccounts.get(categoryId) : undefined;
    const target = mapped ?? config.defaultRevenue;
    const current = splits.get(target.id);
    const amount = new Decimal(line.total as number | string | Prisma.Decimal);
    if (current) {
      current.amount = current.amount.plus(amount);
    } else {
      splits.set(target.id, { name: target.name, amount });
    }
  }
  return splits;
}

/** §8 guard: at least one line per side and exact decimal equality. */
function assertBalanced(lines: DraftLine[]): void {
  const debits = lines.filter((l) => l.side === "debit");
  const credits = lines.filter((l) => l.side === "credit");
  if (debits.length === 0 || credits.length === 0) {
    throw new FinanceError(
      500,
      "UNBALANCED_ENTRY",
      "Cannot post: a journal entry needs at least one debit and one credit line.",
    );
  }
  const debitTotal = debits.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
  const creditTotal = credits.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
  if (!debitTotal.eq(creditTotal)) {
    throw new FinanceError(
      500,
      "UNBALANCED_ENTRY",
      "Cannot post: debits do not equal credits in the generated entry.",
    );
  }
}

/** Write the entry + source link + audit row in one transaction (§18). */
async function insertPosting(input: {
  orgId: string;
  description: string;
  storeId: string;
  lines: DraftLine[];
  sourceLink: {
    loyverseReceiptId: string;
    loyverseRefundId: string | null;
    paymentType: string | null;
    sourceTotal: Prisma.Decimal;
  };
  audit: {
    source: "receipt" | "refund";
    loyverseReceiptId: string;
    loyverseRefundId: string | null;
    paymentType: string | null;
    total: string;
  };
}): Promise<PostingResult> {
  try {
    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.journalEntry.create({
        data: {
          organizationId: input.orgId,
          storeId: input.storeId,
          status: "POSTED",
          description: input.description,
          lines: {
            create: input.lines.map((line) => ({
              organizationId: input.orgId,
              accountId: line.accountId,
              debit: line.side === "debit" ? line.amount.toFixed(2) : "0",
              credit: line.side === "credit" ? line.amount.toFixed(2) : "0",
              memo: line.memo,
            })),
          },
        },
      });
      await tx.ledgerSourceLink.create({
        data: {
          journalEntryId: created.id,
          organizationId: input.orgId,
          storeId: input.storeId,
          loyverseReceiptId: input.sourceLink.loyverseReceiptId,
          loyverseRefundId: input.sourceLink.loyverseRefundId,
          paymentType: input.sourceLink.paymentType,
          sourceTotal: input.sourceLink.sourceTotal.toFixed(2),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: input.orgId,
          action: "journal.posted",
          entityType: "JournalEntry",
          entityId: created.id,
          metadataJson: input.audit,
        },
      });
      return created;
    });
    return { posted: true, journalEntryId: entry.id };
  } catch (error) {
    // A concurrent worker posted the same source: the partial unique index on
    // LedgerSourceLink rejects the duplicate. Report as already posted.
    if (isUniqueViolation(error)) {
      const link = await prisma.ledgerSourceLink.findFirst({
        where: input.sourceLink.loyverseRefundId
          ? { organizationId: input.orgId, loyverseRefundId: input.sourceLink.loyverseRefundId }
          : {
              organizationId: input.orgId,
              loyverseReceiptId: input.sourceLink.loyverseReceiptId,
              loyverseRefundId: null,
            },
        select: { journalEntryId: true },
      });
      if (link) return { posted: false, journalEntryId: link.journalEntryId };
    }
    throw error;
  }
}

function assertPostableTotal(total: Prisma.Decimal, source: string): void {
  if (total.lessThan(0)) {
    throw new FinanceError(
      400,
      "INVALID_SOURCE",
      `${source} total is negative; refusing to post.`,
    );
  }
}

function paymentAccountFor(
  config: PostingConfig,
  paymentType: string | null,
  context: "receipt" | "refund",
): { id: string; name: string } {
  const account = paymentType ? config.paymentAccounts.get(paymentType) : undefined;
  if (!account) {
    const verb = context === "refund" ? "A refund cannot post" : "Cannot post";
    throw new FinanceError(
      400,
      "PAYMENT_TYPE_UNMAPPED",
      `${verb}: no GL account is mapped for payment type "${paymentType ?? "unknown"}". Map it under Finance - GL Mappings.`,
    );
  }
  return account;
}

/**
 * Post one receipt: debit the mapped payment account for the receipt total,
 * credit revenue (per category mapping, defaulting to the 4000 account).
 * Line totals that do not add up to the receipt total are trued up on the
 * default revenue account so the entry always balances.
 */
export async function postReceiptToLedger(
  orgId: string,
  receiptId: string,
): Promise<PostingResult> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, organizationId: orgId },
    include: { lines: true },
  });
  if (!receipt) {
    throw new FinanceError(404, "NOT_FOUND", "Receipt not found.");
  }
  const existing = await prisma.ledgerSourceLink.findFirst({
    where: {
      organizationId: orgId,
      loyverseReceiptId: receipt.loyverseId,
      loyverseRefundId: null,
    },
    select: { journalEntryId: true },
  });
  if (existing) return { posted: false, journalEntryId: existing.journalEntryId };

  const total = new Decimal(receipt.total as number | string | Prisma.Decimal);
  assertPostableTotal(total, "Receipt");
  const config = await loadPostingConfig(orgId);
  const paymentAccount = paymentAccountFor(config, receipt.paymentType, "receipt");

  const lines: DraftLine[] = [
    {
      accountId: paymentAccount.id,
      side: "debit",
      amount: total,
      memo: `Receipt payment (${receipt.paymentType ?? "unknown"})`,
    },
  ];
  const splits = await resolveRevenueSplits(orgId, receipt.lines, config);
  let credited = new Decimal(0);
  for (const [accountId, split] of splits) {
    if (split.amount.lte(0)) continue;
    lines.push({ accountId, side: "credit", amount: split.amount, memo: `Sales - ${split.name}` });
    credited = credited.plus(split.amount);
  }
  const difference = total.minus(credited);
  if (!difference.eq(0)) {
    // Provider rounding / drift between line totals and the receipt total:
    // true-up on the default revenue account, never leave the entry lopsided.
    lines.push({
      accountId: config.defaultRevenue.id,
      side: difference.greaterThan(0) ? "credit" : "debit",
      amount: difference.abs(),
      memo: "Receipt total adjustment",
    });
  }
  assertBalanced(lines);

  const label = receipt.receiptNumber ?? receipt.loyverseId;
  return insertPosting({
    orgId,
    description: `Sale - receipt ${label}`,
    storeId: receipt.storeId,
    lines,
    sourceLink: {
      loyverseReceiptId: receipt.loyverseId,
      loyverseRefundId: null,
      paymentType: receipt.paymentType,
      sourceTotal: total,
    },
    audit: {
      source: "receipt",
      loyverseReceiptId: receipt.loyverseId,
      loyverseRefundId: null,
      paymentType: receipt.paymentType,
      total: total.toFixed(2),
    },
  });
}

/**
 * Post one refund as the mirror of the sale: debit the revenue accounts the
 * sale credited, credit the mapped payment account for the refund total. The
 * original receipt entry is untouched — reversals are new entries (§8).
 */
export async function postRefundToLedger(
  orgId: string,
  refundId: string,
): Promise<PostingResult> {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, organizationId: orgId },
    include: { lines: true, receipt: true },
  });
  if (!refund) {
    throw new FinanceError(404, "NOT_FOUND", "Refund not found.");
  }
  const existing = await prisma.ledgerSourceLink.findFirst({
    where: { organizationId: orgId, loyverseRefundId: refund.loyverseId },
    select: { journalEntryId: true },
  });
  if (existing) return { posted: false, journalEntryId: existing.journalEntryId };

  const total = new Decimal(refund.total as number | string | Prisma.Decimal);
  assertPostableTotal(total, "Refund");
  const config = await loadPostingConfig(orgId);
  const paymentType = refund.receipt.paymentType;
  const paymentAccount = paymentAccountFor(config, paymentType, "refund");

  const lines: DraftLine[] = [];
  const splits = await resolveRevenueSplits(orgId, refund.lines, config);
  let debited = new Decimal(0);
  for (const [accountId, split] of splits) {
    if (split.amount.lte(0)) continue;
    lines.push({ accountId, side: "debit", amount: split.amount, memo: `Refund - ${split.name}` });
    debited = debited.plus(split.amount);
  }
  if (lines.length === 0) {
    // Refund without resolvable lines (or zero-value): still reverse against
    // the default revenue account so cash and revenue stay consistent.
    lines.push({
      accountId: config.defaultRevenue.id,
      side: "debit",
      amount: total,
      memo: `Refund - ${config.defaultRevenue.name}`,
    });
    debited = total;
  }
  lines.push({
    accountId: paymentAccount.id,
    side: "credit",
    amount: total,
    memo: `Refund payment (${paymentType ?? "unknown"})`,
  });
  const difference = total.minus(debited);
  if (!difference.eq(0)) {
    lines.push({
      accountId: config.defaultRevenue.id,
      side: difference.greaterThan(0) ? "debit" : "credit",
      amount: difference.abs(),
      memo: "Refund total adjustment",
    });
  }
  assertBalanced(lines);

  const label = refund.receipt.receiptNumber ?? refund.receipt.loyverseId;
  return insertPosting({
    orgId,
    description: `Refund - receipt ${label}`,
    storeId: refund.receipt.storeId,
    lines,
    sourceLink: {
      loyverseReceiptId: refund.receipt.loyverseId,
      loyverseRefundId: refund.loyverseId,
      paymentType,
      sourceTotal: total,
    },
    audit: {
      source: "refund",
      loyverseReceiptId: refund.receipt.loyverseId,
      loyverseRefundId: refund.loyverseId,
      paymentType,
      total: total.toFixed(2),
    },
  });
}
