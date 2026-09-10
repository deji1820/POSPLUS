"use client";

import { useActionState, useState } from "react";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  createWarehouseAction,
  updateWarehouseAction,
} from "../actions";

interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  storeId: string | null;
  storeName: string | null;
  active: boolean;
}

interface StoreOption {
  id: string;
  name: string;
}

function WarehouseFields({
  stores,
  values,
}: {
  stores: StoreOption[];
  values?: { name?: string; code?: string; storeId?: string | null; active?: boolean };
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Name
        <input
          name="name"
          required
          defaultValue={values?.name}
          placeholder="Main Warehouse"
          className="rounded border p-1.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Code
        <input
          name="code"
          required
          defaultValue={values?.code}
          placeholder="WH-01"
          className="rounded border p-1.5 text-sm uppercase"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Linked store (optional)
        <select name="storeId" defaultValue={values?.storeId ?? ""} className="rounded border p-1.5 text-sm">
          <option value="">— none —</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs sm:col-span-1">
        <input type="checkbox" name="active" defaultChecked={values?.active ?? true} /> Active
      </label>
    </>
  );
}

function WarehouseEditForm({
  warehouse,
  stores,
  onDone,
}: {
  warehouse: WarehouseRow;
  stores: StoreOption[];
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    updateWarehouseAction,
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <input type="hidden" name="id" value={warehouse.id} />
      <WarehouseFields
        stores={stores}
        values={{
          name: warehouse.name,
          code: warehouse.code,
          storeId: warehouse.storeId,
          active: warehouse.active,
        }}
      />
      <div className="flex gap-2 sm:col-span-6 sm:justify-end">
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

function CreateWarehouseForm({ stores, onCreated }: { stores: StoreOption[]; onCreated: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    async (prev, formData) => {
      const result = await createWarehouseAction(prev, formData);
      if (result.ok) onCreated();
      return result;
    },
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <WarehouseFields stores={stores} />
      <div className="sm:col-span-6 sm:text-right">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Adding…" : "Add warehouse"}
        </button>
      </div>
      {state.message && !state.ok && (
        <p className="text-sm text-red-700 sm:col-span-6">{state.message}</p>
      )}
    </form>
  );
}

export function WarehousesManager({
  initialWarehouses,
  stores,
}: {
  initialWarehouses: WarehouseRow[];
  stores: StoreOption[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-gray-500 dark:bg-gray-900">
              <th className="py-2 pl-4 pr-4 font-medium">Code</th>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Linked store</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {initialWarehouses.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-500">
                  No warehouses yet. Add one below.
                </td>
              </tr>
            )}
            {initialWarehouses.map((warehouse) => (
              <tr key={warehouse.id} className="border-b last:border-0 align-top">
                {editingId === warehouse.id ? (
                  <td colSpan={5} className="p-3">
                    <WarehouseEditForm warehouse={warehouse} stores={stores} onDone={() => setEditingId(null)} />
                  </td>
                ) : (
                  <>
                    <td className="py-2 pl-4 pr-4 font-mono text-xs">{warehouse.code}</td>
                    <td className="py-2 pr-4 font-medium">{warehouse.name}</td>
                    <td className="py-2 pr-4 text-gray-500">{warehouse.storeName ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          warehouse.active
                            ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
                            : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                        }
                      >
                        {warehouse.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => setEditingId(warehouse.id)}
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
          <CreateWarehouseForm stores={stores} onCreated={() => setShowCreate(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white"
          >
            + Add warehouse
          </button>
        )}
      </div>
    </div>
  );
}
