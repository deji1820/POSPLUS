"use client";

import { useActionState } from "react";

import { syncNowAction, type LoyverseActionState } from "./actions";

const initialState: LoyverseActionState = { ok: false };

export function SyncNowButton() {
  const [state, formAction, pending] = useActionState(syncNowAction, initialState);

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-gray-900 p-2 text-sm disabled:opacity-50"
        >
          {pending ? "Queueing…" : "Sync now"}
        </button>
      </form>
      {state.message && (
        <p
          role="status"
          className={
            state.ok
              ? "text-sm text-green-700"
              : "text-sm text-red-700"
          }
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
