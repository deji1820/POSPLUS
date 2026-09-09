/**
 * /finance/accounts — SPEC.md §6: chart of accounts with account type,
 * active/inactive state, and store/company applicability. Owner/Accountant
 * only (§5 FINANCE module — the guard enforces it server-side; this page
 * renders an explanation rather than the data when the role lacks access).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listAccounts } from "@/lib/finance/accounts";
import { prisma } from "@/lib/db";

import { AccountRowForm, CreateAccountForm, type AccountRow, type StoreOption } from "./account-forms";

export default async function FinanceAccountsPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">Chart of Accounts</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Chart of Accounts</h1>
        <p className="mt-2 text-sm text-red-700">
          Your role does not permit access to the finance module.
        </p>
      </section>
    );
  }

  const [accounts, stores] = await Promise.all([
    listAccounts(ctx.orgId),
    prisma.store.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const storeOptions: StoreOption[] = stores;
  const rows: AccountRow[] = accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    active: account.active,
    storeId: account.store?.id ?? null,
  }));

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Chart of Accounts</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Account codes are permanent once created. Deactivate accounts you no longer use —
          history stays explainable.
        </p>
      </div>

      <div className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-500">Add account</h2>
        <CreateAccountForm stores={storeOptions} />
      </div>

      <div className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-500">
          Accounts ({accounts.length})
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((account) => (
              <li
                key={account.id}
                className={account.active ? "" : "opacity-60"}
              >
                <AccountRowForm account={account} stores={storeOptions} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
