"use client";

import { useActionState, useState } from "react";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  createDeductionAction,
  createPayrollPeriodAction,
  updateDeductionAction,
} from "./actions";

interface Deduction {
  id: string;
  name: string;
  rate: string | null;
  fixedAmount: string | null;
  effectiveFrom: string;
}

interface Period {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

const dateInput = (iso: string) => iso.slice(0, 10);

function Err({ state }: { state: SettingsActionState }) {
  if (!state.message || state.ok) return null;
  return <p className="text-sm text-red-700">{state.message}</p>;
}

function DeductionFields({
  values,
}: {
  values?: { name?: string; rate?: string | null; fixedAmount?: string | null; effectiveFrom?: string };
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Name
        <input name="name" required defaultValue={values?.name} placeholder="Social Security" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Rate %
        <input name="rate" inputMode="decimal" defaultValue={values?.rate ?? ""} placeholder="e.g. 5" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Fixed amount
        <input name="fixedAmount" inputMode="decimal" defaultValue={values?.fixedAmount ?? ""} placeholder="e.g. 25.00" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Effective from
        <input name="effectiveFrom" type="date" required defaultValue={values?.effectiveFrom ? dateInput(values.effectiveFrom) : undefined} className="rounded border p-1.5 text-sm" />
      </label>
    </>
  );
}

function DeductionRow({ deduction }: { deduction: Deduction }) {
  const [editing, setEditing] = useState(false);
  const [updateState, updateAction, updatePending] = useActionState<SettingsActionState, FormData>(
    updateDeductionAction,
    initialSettingsState,
    );
  return (
    <tr className="border-b last:border-0 align-top">
      {editing ? (
        <td colSpan={4} className="p-3">
          <form action={updateAction} className="grid grid-cols-1 gap-2 sm:grid-cols-5 sm:items-end">
            <input type="hidden" name="id" value={deduction.id} />
            <DeductionFields values={deduction} />
            <div className="flex gap-2 sm:col-span-5 sm:justify-end">
              <button type="submit" disabled={updatePending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
                {updatePending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="rounded border px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
            <div className="sm:col-span-5"><Err state={updateState} /></div>
          </form>
        </td>
      ) : (
        <>
          <td className="py-2 pl-4 pr-4 font-medium">{deduction.name}</td>
          <td className="py-2 pr-4 text-gray-600">
            {deduction.rate !== null ? `${deduction.rate}%` : ""}
            {deduction.rate !== null && deduction.fixedAmount !== null ? " + " : ""}
            {deduction.fixedAmount !== null ? `$${deduction.fixedAmount}` : ""}
          </td>
          <td className="py-2 pr-4 text-gray-500">{dateInput(deduction.effectiveFrom)}</td>
          <td className="py-2 pr-4 text-right">
            <button type="button" onClick={() => setEditing(true)} className="rounded border px-2 py-1 text-xs">
              Edit
            </button>
          </td>
        </>
      )}
    </tr>
  );
}

function CreateDeductionForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    async (prev, formData) => {
      const result = await createDeductionAction(prev, formData);
      if (result.ok) onDone();
      return result;
    },
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-5 sm:items-end">
      <DeductionFields />
      <div className="sm:col-span-5 sm:text-right">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Adding…" : "Add deduction"}
        </button>
      </div>
      <div className="sm:col-span-5"><Err state={state} /></div>
    </form>
  );
}

function PeriodForm({ onCreated }: { onCreated: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    async (prev, formData) => {
      const result = await createPayrollPeriodAction(prev, formData);
      if (result.ok) onCreated();
      return result;
    },
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Period name
        <input name="name" required placeholder="September 2026" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Start
        <input name="startDate" type="date" required className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        End
        <input name="endDate" type="date" required className="rounded border p-1.5 text-sm" />
      </label>
      <div className="sm:col-span-2 sm:text-right">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Adding…" : "Add period"}
        </button>
      </div>
      <div className="sm:col-span-6"><Err state={state} /></div>
    </form>
  );
}

export function PayrollRulesManager({
  deductions,
  periods,
}: {
  deductions: Deduction[];
  periods: Period[];
}) {
  const [showDeduction, setShowDeduction] = useState(false);
  const [showPeriod, setShowPeriod] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-sm font-medium">Statutory deductions</h2>
        <p className="mb-3 text-xs text-gray-500">
          Applied to gross pay per payroll run. Set a percentage rate, a fixed amount, or both.
        </p>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-gray-500 dark:bg-gray-900">
                <th className="py-2 pl-4 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Effective from</th>
                <th className="py-2 pr-4 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {deductions.length === 0 && (
                <tr><td colSpan={4} className="py-6 text-center text-gray-500">No deduction rules yet.</td></tr>
              )}
              {deductions.map((d) => <DeductionRow key={d.id} deduction={d} />)}
            </tbody>
          </table>
        </div>
        <div className="mt-3 rounded border p-3">
          {showDeduction ? (
            <CreateDeductionForm onDone={() => setShowDeduction(false)} />
          ) : (
            <button type="button" onClick={() => setShowDeduction(true)} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
              + Add deduction
            </button>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Payroll periods</h2>
        <p className="mb-3 text-xs text-gray-500">
          The date ranges you run payroll against. Per-employee pay rates are set on the workforce
          employee pages.
        </p>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-gray-500 dark:bg-gray-900">
                <th className="py-2 pl-4 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Start</th>
                <th className="py-2 pr-4 font-medium">End</th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-gray-500">No payroll periods yet.</td></tr>
              )}
              {periods.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="py-2 pl-4 pr-4 font-medium">{p.name}</td>
                  <td className="py-2 pr-4 text-gray-500">{dateInput(p.startDate)}</td>
                  <td className="py-2 pr-4 text-gray-500">{dateInput(p.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 rounded border p-3">
          {showPeriod ? (
            <PeriodForm onCreated={() => setShowPeriod(false)} />
          ) : (
            <button type="button" onClick={() => setShowPeriod(true)} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
              + Add period
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
