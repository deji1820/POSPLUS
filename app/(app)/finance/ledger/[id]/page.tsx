/**
 * /finance/ledger/:id — SPEC.md §6 entry detail: source receipt/refund link,
 * posting date, account lines, debit/credit totals, and the reversal
 * workflow. Owner/Accountant only (§5 FINANCE module). Posted lines are
 * immutable — there are no edit/delete controls here by design; corrections
 * create a linked reversing entry (§8).
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { FinanceError } from "@/lib/finance/errors";
import { getJournalEntry } from "@/lib/finance/ledger";

import { ReverseEntryForm } from "../reverse-form";

export default async function FinanceLedgerEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">Journal Entry</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }
  if (!hasModuleAccess(ctx.role, "FINANCE")) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Journal Entry</h1>
        <p className="mt-2 text-sm text-red-700">
          Your role does not permit access to the finance module.
        </p>
      </section>
    );
  }

  let entry;
  try {
    entry = await getJournalEntry(ctx.orgId, id);
  } catch (error) {
    if (error instanceof FinanceError && error.status === 404) notFound();
    throw error;
  }

  const canReverse =
    entry.status === "POSTED" && !entry.reversedById && !entry.reversalOfId;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Link href="/finance/ledger" className="text-sm text-blue-700 underline">
          ← Back to ledger
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {entry.description ?? "Journal entry"}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Posted {new Date(entry.postedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          {" · "}
          {entry.status}
          {entry.store ? ` · ${entry.store.name}` : ""}
          {entry.fiscalPeriod ? ` · ${entry.fiscalPeriod.name}` : ""}
        </p>
      </div>

      {entry.reversalOfId && (
        <p className="rounded border border-purple-300 bg-purple-50 p-3 text-sm text-purple-800">
          This entry reverses{" "}
          <Link href={`/finance/ledger/${entry.reversalOfId}`} className="underline">
            the original entry
          </Link>
          .
        </p>
      )}
      {entry.reversedById && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          This entry was reversed by{" "}
          <Link href={`/finance/ledger/${entry.reversedById}`} className="underline">
            the reversal entry
          </Link>
          . The original remains part of the permanent record.
        </p>
      )}

      {entry.sourceLink && (
        <div className="rounded border p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-500">Source</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-gray-500">Receipt</dt>
            <dd>{entry.sourceLink.loyverseReceiptId ?? "—"}</dd>
            <dt className="text-gray-500">Refund</dt>
            <dd>{entry.sourceLink.loyverseRefundId ?? "—"}</dd>
            <dt className="text-gray-500">Payment type</dt>
            <dd>{entry.sourceLink.paymentType ?? "—"}</dd>
            <dt className="text-gray-500">Source total</dt>
            <dd className="tabular-nums">{entry.sourceLink.sourceTotal ?? "—"}</dd>
          </dl>
        </div>
      )}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="p-2">Account</th>
              <th className="p-2">Memo</th>
              <th className="p-2 text-right">Debit</th>
              <th className="p-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr key={line.id} className="border-b last:border-0">
                <td className="p-2">
                  <span className="tabular-nums">{line.accountCode}</span> {line.accountName}
                </td>
                <td className="p-2">{line.memo ?? ""}</td>
                <td className="p-2 text-right tabular-nums">{line.debit}</td>
                <td className="p-2 text-right tabular-nums">{line.credit}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-medium">
              <td className="p-2" colSpan={2}>
                Totals
              </td>
              <td className="p-2 text-right tabular-nums">{entry.totalDebit}</td>
              <td className="p-2 text-right tabular-nums">{entry.totalCredit}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-500">Correction</h2>
        {canReverse ? (
          <>
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
              Reversing creates a new posted entry that mirrors this one with debit and credit
              swapped, linked to the original. The entry itself is never modified.
            </p>
            <ReverseEntryForm entryId={entry.id} />
          </>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {entry.reversedById
              ? "This entry has already been reversed."
              : entry.reversalOfId
                ? "Reversal entries cannot be reversed; reverse the original entry instead."
                : "Only posted entries can be reversed."}
          </p>
        )}
      </div>
    </section>
  );
}
