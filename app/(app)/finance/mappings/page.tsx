/**
 * /finance/mappings — SPEC.md §6: map Loyverse payment types and synced
 * categories to GL accounts. These mappings drive auto-posting (#11).
 * Owner/Accountant only (§5 FINANCE module).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listAccounts } from "@/lib/finance/accounts";
import { listMappings } from "@/lib/finance/mappings";
import { prisma } from "@/lib/db";

import { MappingsForm, type AccountOption, type MappingTarget } from "./mapping-form";

const DEFAULT_PAYMENT_TYPES = ["Cash", "Card"];

export default async function FinanceMappingsPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">GL Mappings</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return (
      <section>
        <h1 className="text-xl font-semibold">GL Mappings</h1>
        <p className="mt-2 text-sm text-red-700">
          Your role does not permit access to the finance module.
        </p>
      </section>
    );
  }

  const [accounts, mappings, categories, receiptPaymentTypes] = await Promise.all([
    listAccounts(ctx.orgId),
    listMappings(ctx.orgId),
    prisma.category.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.receipt.findMany({
      where: { organizationId: ctx.orgId, paymentType: { not: null } },
      distinct: ["paymentType"],
      select: { paymentType: true },
    }),
  ]);

  const accountOptions: AccountOption[] = accounts
    .filter((account) => account.active)
    .map((account) => ({ id: account.id, code: account.code, name: account.name }));

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const mappedAccountId = (accountId: string | null) =>
    accountId && accountById.get(accountId)?.active ? accountId : null;

  const paymentTypes = [
    ...new Set([
      ...DEFAULT_PAYMENT_TYPES,
      ...mappings.flatMap((m) => (m.paymentType ? [m.paymentType] : [])),
      ...receiptPaymentTypes.flatMap((r) => (r.paymentType ? [r.paymentType] : [])),
    ]),
  ].sort();
  const mappingFor = (match: (m: (typeof mappings)[number]) => boolean) =>
    mappings.find(match)?.account.id ?? null;

  const paymentTargets: MappingTarget[] = paymentTypes.map((type) => ({
    key: `payment:${type}`,
    label: type,
    currentAccountId: mappedAccountId(mappingFor((m) => m.paymentType === type)),
  }));
  const categoryTargets: MappingTarget[] = categories.map((category) => ({
    key: `category:${category.id}`,
    label: category.name,
    currentAccountId: mappedAccountId(mappingFor((m) => m.category?.id === category.id)),
  }));

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">GL Mappings</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Choose the GL account each Loyverse payment type and category posts into. Saving
          replaces the whole mapping set — unmapped items stay unmapped.
        </p>
      </div>
      <div className="rounded border p-4">
        <MappingsForm
          paymentTargets={paymentTargets}
          categoryTargets={categoryTargets}
          accounts={accountOptions}
        />
      </div>
    </section>
  );
}
