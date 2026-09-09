/**
 * /finance/dashboard — SPEC.md §6: cash/sales summary, posted ledger
 * summary, AP/AR aging (P&L itself is #13 — linked, not duplicated here).
 * Owner/Accountant only (§5 FINANCE module).
 */
import Link from "next/link";

import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { getFinanceDashboard, type AgingSummary } from "@/lib/finance/dashboard";

function AgingCard({ title, aging }: { title: string; aging: AgingSummary }) {
  return (
    <div className="rounded border p-4">
      <h2 className="text-sm font-medium text-gray-500">{title}</h2>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        ${aging.totalOutstanding}
      </p>
      <p className="text-xs text-gray-500">
        {aging.openCount === 0 ? "nothing outstanding" : `${aging.openCount} open`}
      </p>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {aging.buckets.map((bucket) => (
            <tr key={bucket.label} className="border-t first:border-0">
              <td className="py-1 text-gray-600 dark:text-gray-400">{bucket.label}</td>
              <td className="py-1 text-right tabular-nums">{bucket.amount}</td>
              <td className="py-1 text-right text-xs text-gray-500">{bucket.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function FinanceDashboardPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">Finance Dashboard</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }
  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Finance Dashboard</h1>
        <p className="mt-2 text-sm text-red-700">
          Your role does not permit access to the finance module.
        </p>
      </section>
    );
  }

  const d = await getFinanceDashboard(ctx.orgId);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Finance Dashboard</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Figures for {d.month.label} unless noted.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded border p-4">
          <h2 className="text-sm font-medium text-gray-500">Sales (receipts)</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">${d.sales.receiptTotal}</p>
          <p className="text-xs text-gray-500">{d.sales.receiptCount} receipts</p>
        </div>
        <div className="rounded border p-4">
          <h2 className="text-sm font-medium text-gray-500">Refunds</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">${d.sales.refundTotal}</p>
          <p className="text-xs text-gray-500">{d.sales.refundCount} refunds</p>
        </div>
        <div className="rounded border p-4">
          <h2 className="text-sm font-medium text-gray-500">Net sales</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">${d.sales.netSales}</p>
          <p className="text-xs text-gray-500">receipts minus refunds</p>
        </div>
        <div className="rounded border p-4">
          <h2 className="text-sm font-medium text-gray-500">Posted to ledger</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            ${d.ledger.debitsThisMonth}
          </p>
          <p className="text-xs text-gray-500">
            {d.ledger.entriesThisMonth} entries this month · {d.ledger.totalEntries} all time
            {d.ledger.reversedCount > 0 ? ` · ${d.ledger.reversedCount} reversals` : ""}
          </p>
          {d.ledger.lastPostedAt && (
            <p className="mt-1 text-xs text-gray-500">
              Last posting{" "}
              {new Date(d.ledger.lastPostedAt).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <AgingCard title="Accounts receivable aging" aging={d.ar} />
        <AgingCard title="Accounts payable aging" aging={d.ap} />
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/finance/ledger" className="rounded bg-gray-900 px-3 py-1.5 text-white">
          Open ledger
        </Link>
        <Link href="/finance/accounts" className="rounded border px-3 py-1.5">
          Chart of accounts
        </Link>
        <Link href="/finance/mappings" className="rounded border px-3 py-1.5">
          GL mappings
        </Link>
        <Link href="/finance/reports/pnl" className="rounded border px-3 py-1.5">
          P&amp;L report (#13)
        </Link>
      </div>
    </section>
  );
}
