"use client";

import { useActionState } from "react";

import { reverseEntryAction, type ReversalActionState } from "./actions";

const initialState: ReversalActionState = { ok: false };

const inputClass = "rounded border p-1.5 text-sm";
const buttonClass = "rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50";

/**
 * One-click reversal with a required reason (SPEC.md §6 acceptance: "reversal
 * is one click with reason and produces a linked entry"). The reversal is a
 * NEW POSTED entry; the original is never modified.
 */
export function ReverseEntryForm({ entryId }: { entryId: string }) {
  const [state, formAction, pending] = useActionState(reverseEntryAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={entryId} />
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Reason for reversal
        <input
          name="reason"
          required
          maxLength={500}
          className={inputClass}
          placeholder="e.g. Duplicate posting — corrected with supplier"
        />
      </label>
      {state.message && (
        <p
          role="alert"
          className={
            state.ok
              ? "rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800"
              : "rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800"
          }
        >
          {state.message}
          {state.ok && state.reversalEntryId && (
            <>
              {" "}
              <a className="underline" href={`/finance/ledger/${state.reversalEntryId}`}>
                View reversal entry
              </a>
            </>
          )}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Reversing…" : "Reverse this entry"}
        </button>
      </div>
    </form>
  );
}
