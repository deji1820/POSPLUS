"use client";

import { useActionState } from "react";

import {
  connectLoyverseAction,
  type LoyverseActionState,
} from "./actions";

const initialState: LoyverseActionState = { ok: false };

export function ConnectForm() {
  const [state, formAction, pending] = useActionState(connectLoyverseAction, initialState);

  return (
    <>
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
        </p>
      )}
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Loyverse API key
          <input
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            placeholder={state.ok ? "" : "Paste a Loyverse API key"}
            className="rounded border p-2"
          />
        </label>
        <p className="text-xs text-gray-500">
          The key is validated against Loyverse and stored encrypted. It is never shown again.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 p-2 text-white disabled:opacity-50"
        >
          {pending ? "Validating…" : "Connect"}
        </button>
      </form>
    </>
  );
}
