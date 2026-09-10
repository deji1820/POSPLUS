"use client";

import { useActionState } from "react";

import {
  initialReorderState,
  type ReorderActionState,
} from "@/lib/reorder/state";

import {
  acceptSuggestionAction,
  dismissSuggestionAction,
} from "./actions";

interface SuggestionInputs {
  lookbackDays: number;
  averageDailySales: string;
  leadTimeDays: number;
  safetyStockDays: number;
  reorderPoint: string;
  targetStock: string;
  onHand: string;
  onOrder: string;
  computedAt: string | null;
}

export interface SuggestionRow {
  id: string;
  itemName: string;
  variantName: string;
  variantSku: string | null;
  warehouseName: string;
  suggestedQty: string;
  averageDailySales: string;
  reorderPoint: string;
  createdAt: string;
  inputs: SuggestionInputs | null;
}

export interface SupplierOption {
  id: string;
  name: string;
  leadTimeDays: number | null;
}

const inputClass = "rounded border bg-white px-2 py-1 text-sm dark:bg-gray-900";
const buttonClass =
  "rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black";

/** The §12 inputs behind one suggestion, visible on demand per row. */
function InputsBreakdown({ inputs }: { inputs: SuggestionInputs }) {
  const rows: Array<[string, string]> = [
    ["Lookback window", `${inputs.lookbackDays} days`],
    ["Average daily sales", inputs.averageDailySales],
    ["Lead time", `${inputs.leadTimeDays} days`],
    ["Safety stock", `${inputs.safetyStockDays} days`],
    ["Reorder point", inputs.reorderPoint],
    ["Target stock", inputs.targetStock],
    ["On hand", inputs.onHand],
    ["On order (open POs)", inputs.onOrder],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-2">
          <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SuggestionRowView({
  suggestion,
  suppliers,
}: {
  suggestion: SuggestionRow;
  suppliers: SupplierOption[];
}) {
  const [acceptState, acceptAction, acceptPending] = useActionState<
    ReorderActionState,
    FormData
  >(acceptSuggestionAction, initialReorderState);
  const [dismissState, dismissAction, dismissPending] = useActionState<
    ReorderActionState,
    FormData
  >(dismissSuggestionAction, initialReorderState);

  const busy = acceptPending || dismissPending;

  return (
    <div className="border-b px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <div className="min-w-48">
          <div className="text-sm font-medium">
            {suggestion.itemName} — {suggestion.variantName}
            {suggestion.variantSku ? (
              <span className="ml-1 text-xs text-gray-500">({suggestion.variantSku})</span>
            ) : null}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {suggestion.warehouseName} · suggested{" "}
            <span className="font-semibold tabular-nums">{suggestion.suggestedQty}</span> units
            · computed {new Date(suggestion.createdAt).toLocaleString()}
          </div>
        </div>

        <form action={acceptAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <select name="supplierId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Supplier…
            </option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
                {supplier.leadTimeDays !== null ? ` (${supplier.leadTimeDays}d lead)` : ""}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy} className={buttonClass}>
            {acceptPending ? "Accepting…" : "Accept → PO draft"}
          </button>
        </form>

        <form action={dismissAction}>
          <input type="hidden" name="suggestionId" value={suggestion.id} />
          <button
            type="submit"
            disabled={busy}
            className="rounded border px-3 py-1 text-sm text-gray-600 disabled:opacity-50 dark:text-gray-300"
          >
            {dismissPending ? "Dismissing…" : "Dismiss"}
          </button>
        </form>

        {acceptState.message && (
          <p className={`w-full text-sm ${acceptState.ok ? "text-green-700" : "text-red-700"}`}>
            {acceptState.message}
          </p>
        )}
        {dismissState.message && (
          <p className={`w-full text-sm ${dismissState.ok ? "text-green-700" : "text-red-700"}`}>
            {dismissState.message}
          </p>
        )}
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
          Why this suggestion? (sales-velocity inputs)
        </summary>
        <div className="mt-2">
          {suggestion.inputs ? (
            <InputsBreakdown inputs={suggestion.inputs} />
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Inputs recorded by the nightly job: avg daily sales{" "}
              {suggestion.averageDailySales}, reorder point {suggestion.reorderPoint}. Full
              velocity inputs are not stored on this suggestion.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

export function ReorderManager({
  suggestions,
  suppliers,
}: {
  suggestions: SuggestionRow[];
  suppliers: SupplierOption[];
}) {
  if (suggestions.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-gray-500">
        No pending reorder suggestions. The nightly job creates suggestions when
        projected stock falls below its reorder point.
      </p>
    );
  }
  return (
    <div className="divide-y rounded border">
      {suggestions.map((suggestion) => (
        <SuggestionRowView
          key={suggestion.id}
          suggestion={suggestion}
          suppliers={suppliers}
        />
      ))}
    </div>
  );
}
