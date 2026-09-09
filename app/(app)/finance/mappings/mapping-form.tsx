"use client";

import { useActionState } from "react";

import { saveMappingsAction, type MappingsActionState } from "./actions";

const initialState: MappingsActionState = { ok: false };

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

export interface MappingTarget {
  key: string; // "payment:<type>" | "category:<id>"
  label: string;
  currentAccountId: string | null;
}

export function MappingSelect({ name, currentAccountId, accounts }: { name: string; currentAccountId: string | null; accounts: AccountOption[] }) {
  return (
    <select name={name} defaultValue={currentAccountId ?? ""} className="rounded border p-1.5 text-sm">
      <option value="">— unmapped —</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.code} · {account.name}
        </option>
      ))}
    </select>
  );
}

export function MappingsForm({
  paymentTargets,
  categoryTargets,
  accounts,
}: {
  paymentTargets: MappingTarget[];
  categoryTargets: MappingTarget[];
  accounts: AccountOption[];
}) {
  const [state, formAction, pending] = useActionState(saveMappingsAction, initialState);
  const hasCategories = categoryTargets.length > 0;

  return (
    <form action={formAction} className="flex flex-col gap-6">
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

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-500">Payment types</h2>
        <ul className="flex flex-col gap-2">
          {paymentTargets.map((target) => (
            <li key={target.key} className="flex items-center gap-3 text-sm">
              <span className="w-40">{target.label}</span>
              <MappingSelect name={target.key} currentAccountId={target.currentAccountId} accounts={accounts} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-gray-500">Categories</h2>
        {hasCategories ? (
          <ul className="flex flex-col gap-2">
            {categoryTargets.map((target) => (
              <li key={target.key} className="flex items-center gap-3 text-sm">
                <span className="w-40 truncate">{target.label}</span>
                <MappingSelect name={target.key} currentAccountId={target.currentAccountId} accounts={accounts} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">
            No Loyverse categories synced yet — run a sync, then map categories to revenue accounts.
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save mappings"}
      </button>
    </form>
  );
}
