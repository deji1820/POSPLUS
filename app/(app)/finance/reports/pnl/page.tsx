/**
 * /finance/reports/pnl — SPEC.md §6: store-level and consolidated P&L with
 * period comparison. Owner/Accountant only (§5 FINANCE module — the guard
 * enforces server-side; this page renders an explanation when the role lacks
 * access).
 *
 * The statement is computed from POSTED journal lines, so it balances against
 * the ledger by construction (§11 acceptance). When no COGS postings exist in
 * the period, gross profit and net result are visibly labeled as unavailable
 * instead of implying false precision (§11).
 *
 * PDF export is deferred: server-side generation lands with the document
 * pipeline / object storage work (SPEC §20, Sprint 5) — the note below says
 * so rather than offering a broken export.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";
import { getPnlReport, type PnlPeriod } from "@/lib/finance/pnl";

const selectClass = "rounded border p-1.5 text-sm";
const COST_BADGE = "rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800";

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** "2026-09-01" → "Sep 1, 2026" (UTC, matching the report's date semantics). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Signed render: negatives in parentheses, the accounting convention. */
function signed(value: string | null): string {
  if (value === null) return "—";
  const num = Number(value);
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `(${abs})` : abs;
}

function pctChange(current: string | null, previous: string | null): string | null {
  if (current === null || previous === null) return null;
  const prev = Number(previous);
  if (prev === 0) return null;
  const change = ((Number(current) - prev) / Math.abs(prev)) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function GuardNotice() {
  return (
    <section>
      <h1 className="text-xl font-semibold">P&L Report</h1>
      <p className="mt-2 text-sm text-red-700">Your role does not permit access to the finance module.</p>
    </section>
  );
}

function AmountCell({
  value,
  comparison,
  strong,
}: {
  value: string | null;
  comparison: string | null;
  strong?: boolean;
}) {
  const change = pctChange(value, comparison);
  return (
    <td className={`p-2 text-right tabular-nums ${strong ? "font-semibold" : ""}`}>
      {signed(value)}
      {change !== null && (
        <span className={`ml-2 text-xs ${change.startsWith("-") ? "text-red-700" : "text-green-700"}`}>
          {change}
        </span>
      )}
    </td>
  );
}

function ReportTable({
  title,
  period,
  comparison,
  costLabel,
}: {
  title: string;
  period: PnlPeriod;
  comparison: PnlPeriod | null;
  costLabel: string;
}) {
  const comparisonAvailable = comparison !== null;
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-gray-500">
            <th className="p-2">{title}</th>
            {comparisonAvailable && (
              <th className="p-2 text-right">{fmtDate(comparison.from)} – {fmtDate(comparison.to)}</th>
            )}
            <th className="p-2 text-right">
              {fmtDate(period.from)} – {fmtDate(period.to)}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b last:border-0">
            <td className="p-2">Sales</td>
            {comparisonAvailable && <AmountCell value={comparison.sales} comparison={null} />}
            <AmountCell value={period.sales} comparison={comparison?.sales ?? null} />
          </tr>
          <tr className="border-b last:border-0">
            <td className="p-2 pl-6 text-gray-600 dark:text-gray-400">Refunds (contra-revenue)</td>
            {comparisonAvailable && <AmountCell value={comparison.refunds} comparison={null} />}
            <AmountCell value={period.refunds} comparison={comparison?.refunds ?? null} />
          </tr>
          {period.adjustments !== "0.00" && (
            <tr className="border-b last:border-0">
              <td className="p-2 pl-6 text-gray-600 dark:text-gray-400">Adjustments (reversals, manual)</td>
              {comparisonAvailable && <AmountCell value={comparison.adjustments} comparison={null} />}
              <AmountCell value={period.adjustments} comparison={comparison?.adjustments ?? null} />
            </tr>
          )}
          <tr className="border-b last:border-0">
            <td className="p-2 font-semibold">Net revenue</td>
            {comparisonAvailable && <AmountCell value={comparison.netRevenue} comparison={null} strong />}
            <AmountCell value={period.netRevenue} comparison={comparison?.netRevenue ?? null} strong />
          </tr>
          <tr className="border-b last:border-0">
            <td className="p-2">Cost of goods sold</td>
            {comparisonAvailable && <AmountCell value={comparison.cogs} comparison={null} />}
            <AmountCell value={period.cogs} comparison={comparison?.cogs ?? null} />
          </tr>
          <tr className="border-b last:border-0">
            <td className="p-2 font-semibold">
              Gross profit{" "}
              {!period.costDataComplete && <span className={COST_BADGE}>cost data unavailable</span>}
            </td>
            {comparisonAvailable && (
              <AmountCell value={comparison.grossProfit} comparison={null} strong />
            )}
            <AmountCell value={period.grossProfit} comparison={comparison?.grossProfit ?? null} strong />
          </tr>
          {period.operatingExpenses.map((row) => (
            <tr key={row.accountId} className="border-b last:border-0">
              <td className="p-2 pl-6 text-gray-600 dark:text-gray-400">
                {row.code} — {row.name}
              </td>
              {comparisonAvailable && (
                <AmountCell
                  value={
                    comparison.operatingExpenses.find((c) => c.accountId === row.accountId)?.amount ?? "0.00"
                  }
                  comparison={null}
                />
              )}
              <AmountCell value={row.amount} comparison={null} />
            </tr>
          ))}
          <tr className="border-b last:border-0">
            <td className="p-2">Total operating expenses</td>
            {comparisonAvailable && (
              <AmountCell value={comparison.totalOperatingExpenses} comparison={null} />
            )}
            <AmountCell
              value={period.totalOperatingExpenses}
              comparison={comparison?.totalOperatingExpenses ?? null}
            />
          </tr>
          <tr className="border-b last:border-0">
            <td className="p-2 font-semibold">
              Net result{" "}
              {!period.costDataComplete && <span className={COST_BADGE}>cost data unavailable</span>}
            </td>
            {comparisonAvailable && <AmountCell value={comparison.netResult} comparison={null} strong />}
            <AmountCell value={period.netResult} comparison={comparison?.netResult ?? null} strong />
          </tr>
        </tbody>
      </table>
      {!period.costDataComplete && (
        <p className="border-t p-2 text-xs text-amber-800">{costLabel}.</p>
      )}
      {period.balances && (
        <p className="border-t p-2 text-xs text-gray-500">
          Revenue buckets reconcile exactly against posted journal lines for this period.
        </p>
      )}
    </div>
  );
}

export default async function FinancePnlPage({
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
          <h1 className="text-xl font-semibold">P&L Report</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }
  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return <GuardNotice />;
  }

  const filters = {
    storeId: single(params.storeId) || undefined,
    from: single(params.from) || undefined,
    to: single(params.to) || undefined,
    compare: single(params.compare) || undefined,
  };

  let report;
  let stores: { id: string; name: string }[] = [];
  try {
    [report, stores] = await Promise.all([
      getPnlReport(ctx.orgId, filters),
      prisma.store.findMany({
        where: { organizationId: ctx.orgId },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);
  } catch (error) {
    if (error instanceof FinanceError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">P&L Report</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }

  const periodLabel = report.consolidated
    ? "Consolidated — all stores"
    : (stores.find((s) => s.id === report.storeId)?.name ?? "Selected store");

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">P&L Report</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Computed from posted journal lines — {periodLabel}, {fmtDate(report.period.from)} –{" "}
          {fmtDate(report.period.to)}.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Store
          <select name="storeId" className={selectClass} defaultValue={report.storeId ?? ""}>
            <option value="">All stores (consolidated)</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          From
          <input
            type="date"
            name="from"
            className={selectClass}
            defaultValue={report.period.from.slice(0, 10)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          To
          <input
            type="date"
            name="to"
            className={selectClass}
            defaultValue={report.period.to.slice(0, 10)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" name="compare" value="1" defaultChecked={!!report.comparison} />
          Compare with previous period
        </label>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
          Run report
        </button>
      </form>

      <ReportTable
        title="Line item"
        period={report.period}
        comparison={report.comparison}
        costLabel={report.costLabel}
      />

      <div className="rounded border border-dashed p-3 text-sm text-gray-600 dark:text-gray-400">
        PDF export is planned with the document pipeline (object storage) in Sprint 5 — until then,
        use your browser&apos;s print function to save this report as PDF.
      </div>
    </section>
  );
}
