"use client";

import { useActionState, useState } from "react";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  createStoreAction,
  updateStoreAction,
} from "../actions";

interface StoreRow {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  loyverseStoreId: string | null;
  active: boolean;
}

function StateMessage({ state }: { state: SettingsActionState }) {
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

function StoreEditForm({ store, onDone }: { store: StoreRow; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    updateStoreAction,
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <input type="hidden" name="id" value={store.id} />
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Name
        <input name="name" defaultValue={store.name} required className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Address
        <input name="address" defaultValue={store.address ?? ""} className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Timezone
        <input name="timezone" defaultValue={store.timezone ?? ""} placeholder="UTC" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Loyverse store id
        <input name="loyverseStoreId" defaultValue={store.loyverseStoreId ?? ""} className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex items-center gap-2 text-xs sm:col-span-2">
        <input type="checkbox" name="active" defaultChecked={store.active} /> Active
      </label>
      <div className="flex gap-2 sm:col-span-4 sm:justify-end">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onDone} className="rounded border px-3 py-1.5 text-sm">
          Cancel
        </button>
      </div>
      {state.message && !state.ok && (
        <p className="text-sm text-red-700 sm:col-span-6">{state.message}</p>
      )}
    </form>
  );
}

function CreateStoreForm({ onCreated }: { onCreated: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    async (prev, formData) => {
      const result = await createStoreAction(prev, formData);
      if (result.ok) onCreated();
      return result;
    },
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Name
        <input name="name" required placeholder="New store" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Address
        <input name="address" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Timezone
        <input name="timezone" placeholder="UTC" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Loyverse store id
        <input name="loyverseStoreId" placeholder="optional" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex items-center gap-2 text-xs sm:col-span-2">
        <input type="checkbox" name="active" defaultChecked /> Active
      </label>
      <div className="sm:col-span-4 sm:text-right">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Adding…" : "Add store"}
        </button>
      </div>
      {state.message && !state.ok && (
        <p className="text-sm text-red-700 sm:col-span-6">{state.message}</p>
      )}
    </form>
  );
}

export function StoresManager({ initialStores }: { initialStores: StoreRow[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [globalState, setGlobalState] = useState<SettingsActionState>(initialSettingsState);

  return (
    <div className="flex flex-col gap-4">
      {globalState.message && <StateMessage state={globalState} />}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-gray-500 dark:bg-gray-900">
              <th className="py-2 pl-4 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Loyverse id</th>
              <th className="py-2 pr-4 font-medium">Timezone</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {initialStores.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-500">
                  No stores yet. Add one below.
                </td>
              </tr>
            )}
            {initialStores.map((store) => (
              <tr key={store.id} className="border-b last:border-0 align-top">
                {editingId === store.id ? (
                  <td colSpan={5} className="p-3">
                    <StoreEditForm
                      store={store}
                      onDone={() => {
                        setEditingId(null);
                        setGlobalState({ ok: true, message: "Store updated." });
                      }}
                    />
                  </td>
                ) : (
                  <>
                    <td className="py-2 pl-4 pr-4 font-medium">{store.name}</td>
                    <td className="py-2 pr-4 text-gray-500">{store.loyverseStoreId ?? "—"}</td>
                    <td className="py-2 pr-4 text-gray-500">{store.timezone ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          store.active
                            ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
                            : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                        }
                      >
                        {store.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => setEditingId(store.id)}
                        className="rounded border px-2 py-1 text-xs"
                      >
                        Edit
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded border p-3">
        {showCreate ? (
          <CreateStoreForm onCreated={() => setShowCreate(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white"
          >
            + Add store
          </button>
        )}
      </div>
    </div>
  );
}
