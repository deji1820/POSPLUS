/**
 * Baseline chart of accounts (SPEC.md §21) — shared by the dev seed
 * (prisma/seed.ts) and the post-sync setup checklist (sync engine step 11,
 * #7): an organization that just finished its first sync should have accounts
 * for auto-posting to target without a manual trip to /finance/accounts.
 *
 * Idempotent by construction: accounts upsert on (organizationId, code) and
 * default payment-type mappings are created only when that payment type has
 * NO mapping yet — an operator's customizations are never overwritten.
 */
import type { GLAccountType } from "@prisma/client";

import { prisma } from "@/lib/db";

export const BASELINE_COA: Array<{ code: string; name: string; type: GLAccountType }> = [
  { code: "1000", name: "Cash on Hand", type: "ASSET" },
  { code: "1010", name: "Bank Account", type: "ASSET" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { code: "1200", name: "Inventory", type: "ASSET" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { code: "2100", name: "Payroll Liabilities", type: "LIABILITY" },
  { code: "3000", name: "Owner's Equity", type: "EQUITY" },
  { code: "4000", name: "Sales Revenue", type: "REVENUE" },
  { code: "4100", name: "Refunds (Contra Revenue)", type: "REVENUE" },
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: "6000", name: "Operating Expenses", type: "EXPENSE" },
  { code: "6100", name: "Labor Cost", type: "EXPENSE" },
];

/** Default Loyverse payment type → account code, seeded when unmapped. */
const DEFAULT_PAYMENT_MAPPINGS: Array<{ paymentType: string; accountCode: string }> = [
  { paymentType: "Cash", accountCode: "1000" },
  { paymentType: "Card", accountCode: "1010" },
];

export async function ensureBaselineCoa(orgId: string): Promise<{ accounts: number; mappings: number }> {
  for (const account of BASELINE_COA) {
    await prisma.gLAccount.upsert({
      where: { organizationId_code: { organizationId: orgId, code: account.code } },
      update: {},
      create: { organizationId: orgId, ...account },
    });
  }

  let mappings = 0;
  const existing = await prisma.gLMapping.findMany({
    where: { organizationId: orgId, paymentType: { not: null } },
    select: { paymentType: true },
  });
  const mapped = new Set(existing.map((m) => m.paymentType));
  for (const def of DEFAULT_PAYMENT_MAPPINGS) {
    if (mapped.has(def.paymentType)) continue;
    const account = await prisma.gLAccount.findUnique({
      where: { organizationId_code: { organizationId: orgId, code: def.accountCode } },
      select: { id: true },
    });
    if (!account) continue; // cannot happen: the account was just upserted
    await prisma.gLMapping.create({
      data: { organizationId: orgId, paymentType: def.paymentType, accountId: account.id },
    });
    mappings += 1;
  }
  return { accounts: BASELINE_COA.length, mappings };
}
