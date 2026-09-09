/**
 * Chart of accounts use-cases (SPEC.md §6 "/finance/accounts", §7
 * `GET/POST /api/finance/accounts`, `PATCH /api/finance/accounts/:id`).
 *
 * Every query and write is scoped to the caller's organization. The account
 * `code` is create-only — renaming/retyping/deactivating is allowed, but a
 * code that has posted journal lines behind it must never be repurposed.
 * Deactivation (active=false) replaces deletion; posted history stays
 * explainable.
 *
 * Store applicability: `storeId` set → account only applies to that store;
 * null → company-wide.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

export const createAccountSchema = z.object({
  code: z.string().trim().min(1, "Account code is required.").max(20),
  name: z.string().trim().min(1, "Account name is required.").max(100),
  type: z.enum(ACCOUNT_TYPES),
  active: z.boolean().optional(),
  /** null/absent = company-wide applicability. */
  storeId: z.string().min(1).nullable().optional(),
});

/** `code` is immutable after creation. */
export const updateAccountSchema = createAccountSchema.omit({ code: true }).partial();

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export interface AccountSummary {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
  store: { id: string; name: string } | null; // null = company-wide
}

function toSummary(account: {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
  store: { id: string; name: string } | null;
}): AccountSummary {
  return account;
}

export async function listAccounts(orgId: string): Promise<AccountSummary[]> {
  const accounts = await prisma.gLAccount.findMany({
    where: { organizationId: orgId },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true, active: true, store: { select: { id: true, name: true } } },
  });
  return accounts.map(toSummary);
}

/** A store reference must belong to the same org (no cross-tenant FKs). */
async function assertStoreInOrg(orgId: string, storeId: string | null | undefined): Promise<void> {
  if (!storeId) return;
  const store = await prisma.store.findFirst({
    where: { id: storeId, organizationId: orgId },
    select: { id: true },
  });
  if (!store) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Store does not exist in this organization.");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export async function createAccount(orgId: string, raw: unknown): Promise<AccountSummary> {
  const input = createAccountSchema.safeParse(raw);
  if (!input.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", input.error.issues[0]?.message ?? "Invalid account.");
  }
  await assertStoreInOrg(orgId, input.data.storeId);
  try {
    const account = await prisma.gLAccount.create({
      data: {
        organizationId: orgId,
        code: input.data.code,
        name: input.data.name,
        type: input.data.type,
        active: input.data.active ?? true,
        storeId: input.data.storeId ?? null,
      },
      select: { id: true, code: true, name: true, type: true, active: true, store: { select: { id: true, name: true } } },
    });
    return toSummary(account);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new FinanceError(409, "ACCOUNT_CODE_EXISTS", `Account code "${input.data.code}" already exists.`);
    }
    throw error;
  }
}

export async function updateAccount(
  orgId: string,
  accountId: string,
  raw: unknown,
): Promise<AccountSummary> {
  const existing = await prisma.gLAccount.findFirst({
    where: { id: accountId, organizationId: orgId },
    select: { id: true },
  });
  if (!existing) {
    throw new FinanceError(404, "NOT_FOUND", "Account not found.");
  }
  const input = updateAccountSchema.safeParse(raw);
  if (!input.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", input.error.issues[0]?.message ?? "Invalid account update.");
  }
  await assertStoreInOrg(orgId, input.data.storeId);
  const account = await prisma.gLAccount.update({
    where: { id: existing.id },
    data: {
      ...(input.data.name !== undefined ? { name: input.data.name } : {}),
      ...(input.data.type !== undefined ? { type: input.data.type } : {}),
      ...(input.data.active !== undefined ? { active: input.data.active } : {}),
      ...(input.data.storeId !== undefined ? { storeId: input.data.storeId } : {}),
    },
    select: { id: true, code: true, name: true, type: true, active: true, store: { select: { id: true, name: true } } },
  });
  return toSummary(account);
}
