/**
 * GL mapping use-cases (SPEC.md §6 "/finance/mappings", §7
 * `GET/PUT /api/finance/mappings`).
 *
 * A mapping points ONE Loyverse dimension at ONE GL account:
 *   - `paymentType` → account: which ledger account receipts paid by this
 *     Loyverse payment type post into (Cash, Card, ...), or
 *   - `categoryId` → account: which revenue account sales of this synced
 *     Loyverse category post into.
 * Exactly one of the two must be set per row.
 *
 * PUT replaces the organization's entire mapping set in one transaction —
 * the set is small (payment types + categories), so full replacement is the
 * honest model for "this is the current configuration" and makes the next
 * issue's auto-posting read a single consistent snapshot. Every row is
 * validated up front; ANY invalid row rejects the whole PUT with an
 * operator-safe error (no partial, silently-divergent state).
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

export const mappingRowSchema = z
  .object({
    paymentType: z.string().trim().min(1).max(50).optional(),
    categoryId: z.string().min(1).optional(),
    accountId: z.string().min(1),
  })
  .refine((row) => (row.paymentType ? !row.categoryId : !!row.categoryId), {
    message: "Each mapping sets exactly one of paymentType or categoryId.",
  });

export const putMappingsSchema = z.object({
  mappings: z.array(mappingRowSchema).max(500),
});

export interface MappingSummary {
  id: string;
  paymentType: string | null;
  category: { id: string; name: string } | null;
  account: { id: string; code: string; name: string };
}

export async function listMappings(orgId: string): Promise<MappingSummary[]> {
  const mappings = await prisma.gLMapping.findMany({
    where: { organizationId: orgId },
    orderBy: [{ paymentType: "asc" }, { category: { name: "asc" } }],
    select: {
      id: true,
      paymentType: true,
      category: { select: { id: true, name: true } },
      account: { select: { id: true, code: true, name: true } },
    },
  });
  return mappings;
}

interface ValidatedRow {
  paymentType: string | null;
  categoryId: string | null;
  accountId: string;
}

/** Validate every row up front; the first problem fails the whole PUT. */
async function validateRows(orgId: string, raw: unknown): Promise<ValidatedRow[]> {
  const parsed = putMappingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid mappings.");
  }
  const rows = parsed.data.mappings;

  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const key = row.paymentType ? `payment:${row.paymentType}` : `category:${row.categoryId}`;
    if (seen.has(key)) {
      throw new FinanceError(
        400,
        "VALIDATION_ERROR",
        `Mapping ${index + 1} duplicates another row for the same ${row.paymentType ? "payment type" : "category"}.`,
      );
    }
    seen.add(key);
  }

  const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((v): v is string => !!v))];
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const [categories, accounts] = await Promise.all([
    categoryIds.length
      ? prisma.category.findMany({ where: { organizationId: orgId, id: { in: categoryIds } }, select: { id: true } })
      : Promise.resolve([] as Array<{ id: string }>),
    accountIds.length
      ? prisma.gLAccount.findMany({ where: { organizationId: orgId, id: { in: accountIds } }, select: { id: true, active: true } })
      : Promise.resolve([] as Array<{ id: string; active: boolean }>),
  ]);
  const categorySet = new Set(categories.map((c) => c.id));
  const accountMap = new Map(accounts.map((a) => [a.id, a.active]));

  for (const [index, row] of rows.entries()) {
    if (row.categoryId && !categorySet.has(row.categoryId)) {
      throw new FinanceError(400, "VALIDATION_ERROR", `Mapping ${index + 1} references a category that does not exist.`);
    }
    const active = accountMap.get(row.accountId);
    if (active === undefined) {
      throw new FinanceError(400, "VALIDATION_ERROR", `Mapping ${index + 1} references an account that does not exist.`);
    }
    if (!active) {
      throw new FinanceError(400, "VALIDATION_ERROR", `Mapping ${index + 1} references an inactive account.`);
    }
  }

  return rows.map((row) => ({
    paymentType: row.paymentType ?? null,
    categoryId: row.categoryId ?? null,
    accountId: row.accountId,
  }));
}

export async function replaceMappings(orgId: string, raw: unknown): Promise<MappingSummary[]> {
  const rows = await validateRows(orgId, raw);
  await prisma.$transaction([
    prisma.gLMapping.deleteMany({ where: { organizationId: orgId } }),
    prisma.gLMapping.createMany({
      data: rows.map((row) => ({ organizationId: orgId, ...row })),
    }),
  ]);
  return listMappings(orgId);
}
