/**
 * /finance/ledger — SPEC.md §6: journal-entry list with filtering (period,
 * store, account, source type). Owner/Accountant only (§5 FINANCE module —
 * the guard enforces server-side; this page renders an explanation when the
 * role lacks access).
 *
 * Posted entries are immutable: this page deliberately renders NO edit or
 * delete affordances — corrections go through the reversal workflow on the
 * entry detail page (§8: reversals create new linked entries).
 */
import Link from "next/link";

import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { JOURNAL_SOURCE_TYPES, listJournalEntries, type JournalSourceType } from "@/lib/finance/ledger";

const SOURCE_LABELS: Record<JournalSourceType, string> = {
  receipt: "Receipt",
  refund: "Refund",
  reversal: "Reversal",
  manual: "Manual",
};

const selectClass = "rounded border p-1.5 text-sm";
const badgeClass: Record<JournalSourceType, string> = {
  receipt: "bg-blue-100 text-blue-800",
  refund: "bg-amber-100 text-amber-800",
  reversal: "bg-purple-100 text-purple-800",
  manual: "bg-gray-100 text-gray-700",
};

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function GuardNotice({ title }: { title: string }) {
  return (
    <section>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-red-700">
        Your role does not permit access to the finance module.
      </p>
    </section>
  );
}

export default async function FinanceLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">Ledger</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }
  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return <GuardNotice title="Ledger" />;
  }

  const filters = {
    fiscalPeriodId: single(params.fiscalPeriodId) || undefined,
    storeId: single(params.storeId) || undefined,
    accountId: single(params.accountId) || undefined,
    source: single(params.source) || undefined,
  };
  const [entries, stores, accounts, periods] = await Promise.all([
    listJournalEntries(ctx.orgId, filters),
    prisma.store.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.gLAccount.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.fiscalPeriod.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { startDate: "desc" },
      select: { id: true, name: true },
    }),
  ]);

  const active = (key: keyof typeof filters) =>
    filters[key] ? { defaultValue: filters[key] } : {};

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Ledger</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Posted journal entries are permanent — corrections are made by reversing an entry,
          never by editing it.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Source
          <select name="source" className={selectClass} {...active("source")}>
            <option value="">All sources</option>
            {JOURNAL_SOURCE_TYPES.map((source) => (
              <option key={source} value={source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Period
          <select name="fiscalPeriodId" className={selectClass} {...active("fiscalPeriodId")}>
            <option value="">All periods</option>
            {periods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Store
          <select name="storeId" className={selectClass} {...active("storeId")}>
            <option value="">All stores</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Account
          <select name="accountId" className={selectClass} {...active("accountId")}>
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
          Filter
        </button>
        {(filters.source || filters.fiscalPeriodId || filters.storeId || filters.accountId) && (
          <Link href="/finance/ledger" className="text-sm underline">
            Clear
          </Link>
        )}
      </form>

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="p-2">Posted</th>
              <th className="p-2">Description</th>
              <th className="p-2">Source</th>
              <th className="p-2">Store</th>
              <th className="p-2 text-right">Debit</th>
              <th className="p-2 text-right">Credit</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b last:border-0">
                <td className="whitespace-nowrap p-2">
                  {new Date(entry.postedAt).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </td>
                <td className="p-2">
                  <Link href={`/finance/ledger/${entry.id}`} className="text-blue-700 underline">
                    {entry.description ?? "(no description)"}
                  </Link>
                </td>
                <td className="p-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${badgeClass[entry.sourceType]}`}>
                    {SOURCE_LABELS[entry.sourceType]}
                  </span>
                </td>
                <td className="p-2">{entry.store?.name ?? "—"}</td>
                <td className="p-2 text-right tabular-nums">{entry.totalDebit}</td>
                <td className="p-2 text-right tabular-nums">{entry.totalCredit}</td>
                <td className="p-2 text-xs">
                  {entry.reversalOfId && "Reverses another entry"}
                  {entry.reversedById && "Reversed"}
                  {!entry.reversalOfId && !entry.reversedById && "Posted"}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-sm text-gray-500">
                  No journal entries match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
