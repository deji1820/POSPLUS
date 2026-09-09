"use client";

import { useActionState } from "react";

import type { ACCOUNT_TYPES } from "@/lib/finance/accounts";

import {
  createAccountAction,
  updateAccountAction,
  type FinanceActionState,
} from "./actions";

const initialState: FinanceActionState = { ok: false };

const TYPE_OPTIONS: Array<{ value: (typeof ACCOUNT_TYPES)[number]; label: string }> = [
  { value: "ASSET", label: "Asset" },
  { value: "LIABILITY", label: "Liability" },
  { value: "EQUITY", label: "Equity" },
  { value: "REVENUE", label: "Revenue" },
  { value: "EXPENSE", label: "Expense" },
];

export interface StoreOption {
  id: string;
  name: string;
}

function StateMessage({ state }: { state: FinanceActionState }) {
  if (!state.message) return null;
  return (
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
  );
}

const inputClass = "rounded border p-1.5 text-sm";
const buttonClass = "rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50";

export function CreateAccountForm({ stores }: { stores: StoreOption[] }) {
  const [state, formAction, pending] = useActionState(createAccountAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <StateMessage state={state} />
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Code
        <input name="code" required maxLength={20} className={inputClass} placeholder="4050" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Name
        <input name="name" required maxLength={100} className={inputClass} placeholder="Card Sales" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Type
        <select name="type" className={inputClass} defaultValue="REVENUE">
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Applicability
        <select name="storeId" className={inputClass} defaultValue="">
          <option value="">Company-wide</option>
          {stores.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating…" : "Add account"}
      </button>
    </form>
  );
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
  storeId: string | null;
}

export function AccountRowForm({ account, stores }: { account: AccountRow; stores: StoreOption[] }) {
  const [state, formAction, pending] = useActionState(updateAccountAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={account.id} />
      <span className="w-16 font-mono text-sm">{account.code}</span>
      <input name="name" defaultValue={account.name} required maxLength={100} className={inputClass} />
      <select name="type" defaultValue={account.type} className={inputClass}>
        {TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        name="storeId"
        defaultValue={account.storeId ?? ""}
        className={inputClass}
        aria-label="Applicability"
      >
        <option value="">Company-wide</option>
        {stores.map((store) => (
          <option key={store.id} value={store.id}>
            {store.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-gray-500">
        <input type="checkbox" name="active" defaultChecked={account.active} />
        Active
      </label>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state.message && !state.ok && <span className="text-xs text-red-700">{state.message}</span>}
      {state.message && state.ok && <span className="text-xs text-green-700">{state.message}</span>}
    </form>
  );
}
