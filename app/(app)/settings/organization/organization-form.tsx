"use client";

import { useActionState } from "react";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  updateOrganizationAction,
} from "../actions";

export function OrganizationForm({
  initial,
}: {
  initial: { name: string; currency: string; timezone: string };
}) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    updateOrganizationAction,
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
          Organization name
          <input
            name="name"
            type="text"
            required
            defaultValue={initial.name}
            className="rounded border p-2"
          />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Currency (ISO code)
            <input
              name="currency"
              type="text"
              required
              minLength={3}
              maxLength={3}
              defaultValue={initial.currency}
              placeholder="USD"
              className="rounded border p-2 uppercase"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Timezone
            <input
              name="timezone"
              type="text"
              required
              defaultValue={initial.timezone}
              placeholder="UTC"
              className="rounded border p-2"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 p-2 text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save organization"}
        </button>
      </form>
    </>
  );
}
