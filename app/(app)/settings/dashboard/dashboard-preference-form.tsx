"use client";

import { useActionState } from "react";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  saveDashboardPreferenceAction,
} from "./actions";

export function DashboardPreferenceForm({
  initial,
}: {
  initial: { mode: string | null; scope: string | null; period: string | null };
}) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    saveDashboardPreferenceAction,
    initialSettingsState,
    );

  return (
    <>
      {state.message && (
        <p
          role="alert"
          className={
            state.ok
              ? "mb-3 rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800"
              : "mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800"
          }
        >
          {state.message}
        </p>
      )}
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Dashboard mode
          <select name="mode" defaultValue={initial.mode ?? "stores"} className="rounded border p-2">
            <option value="stores">Stores</option>
            <option value="commissary">Commissary</option>
          </select>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Scope (store/commissary id, or blank for all)
            <input
              name="scope"
              defaultValue={initial.scope ?? ""}
              placeholder="all"
              className="rounded border p-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Period
            <select name="period" defaultValue={initial.period ?? "this_month"} className="rounded border p-2">
              <option value="this_week">This week</option>
              <option value="this_month">This month</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 p-2 text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save preference"}
        </button>
      </form>
    </>
  );
}
