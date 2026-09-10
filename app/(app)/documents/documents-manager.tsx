"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { DOCUMENT_TYPE_LABELS, type DocumentEntityType } from "@/lib/documents/catalog";

export interface DocumentListItem {
  id: string;
  entityType: DocumentEntityType;
  entityId: string | null;
  status: "PENDING" | "GENERATED" | "FAILED";
  storageKey: string;
  checksum: string;
  createdAt: string; // ISO
  paramsJson: Record<string, unknown> | null;
}

export interface PoOption {
  id: string;
  number: string;
  supplierName: string;
  status: string;
}

export interface PayslipOption {
  id: string;
  employeeName: string;
  periodName: string;
  runStatus: string;
}

export interface StoreOption {
  id: string;
  name: string;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const statusStyle: Record<DocumentListItem["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  GENERATED: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await res.json()) as Envelope<T>;
  if (!res.ok || !envelope.ok) {
    throw new Error(envelope.error?.message ?? `Request failed (${res.status}).`);
  }
  return envelope.data as T;
}

function describe(item: DocumentListItem): string {
  if (item.entityType === "PNL_REPORT") {
    const p = item.paramsJson ?? {};
    const from = typeof p.from === "string" ? p.from.slice(0, 10) : "…";
    const to = typeof p.to === "string" ? p.to.slice(0, 10) : "…";
    return `${from} – ${to}`;
  }
  return item.entityId ? item.entityId.slice(0, 8) : "—";
}

export function DocumentsManager({
  documents,
  poOptions,
  payslipOptions,
  stores,
  canPo,
  canPayslip,
  canPnl,
}: {
  documents: DocumentListItem[];
  poOptions: PoOption[];
  payslipOptions: PayslipOption[];
  stores: StoreOption[];
  canPo: boolean;
  canPayslip: boolean;
  canPnl: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [poId, setPoId] = useState(poOptions[0]?.id ?? "");
  const [payslipId, setPayslipId] = useState(payslipOptions[0]?.id ?? "");
  const [pnlFrom, setPnlFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [pnlTo, setPnlTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [pnlStoreId, setPnlStoreId] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const anyPending = documents.some((d) => d.status === "PENDING");

  // While a document is rendering, keep refreshing the server-rendered list.
  useEffect(() => {
    if (anyPending && !pollRef.current) {
      pollRef.current = setInterval(() => router.refresh(), 4000);
    } else if (!anyPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [anyPending, router]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const buttonClass =
    "rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black";
  const selectClass = "rounded border bg-white px-2 py-1 text-sm dark:bg-gray-900";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        {canPo && (
          <div className="flex flex-1 flex-col gap-2 rounded border p-4">
            <h2 className="text-sm font-semibold">Purchase order PDF</h2>
            <select value={poId} onChange={(e) => setPoId(e.target.value)} className={selectClass}>
              {poOptions.length === 0 && <option value="">No purchase orders yet</option>}
              {poOptions.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.number} · {po.supplierName} · {po.status}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !poId}
              onClick={() =>
                run(
                  () => post("/api/documents", { entityType: "PURCHASE_ORDER", entityId: poId }),
                  "Purchase order PDF requested.",
                )
              }
              className={buttonClass}
            >
              Generate PO PDF
            </button>
          </div>
        )}

        {canPayslip && (
          <div className="flex flex-1 flex-col gap-2 rounded border p-4">
            <h2 className="text-sm font-semibold">Payslip PDF</h2>
            <select
              value={payslipId}
              onChange={(e) => setPayslipId(e.target.value)}
              className={selectClass}
            >
              {payslipOptions.length === 0 && <option value="">No payroll lines yet</option>}
              {payslipOptions.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.employeeName} · {line.periodName} · {line.runStatus}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !payslipId}
              onClick={() =>
                run(
                  () => post("/api/documents", { entityType: "PAYSLIP", entityId: payslipId }),
                  "Payslip PDF requested.",
                )
              }
              className={buttonClass}
            >
              Generate payslip PDF
            </button>
          </div>
        )}

        {canPnl && (
          <div className="flex flex-1 flex-col gap-2 rounded border p-4">
            <h2 className="text-sm font-semibold">P&amp;L report PDF</h2>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">
                From
                <input
                  type="date"
                  value={pnlFrom}
                  onChange={(e) => setPnlFrom(e.target.value)}
                  className={selectClass}
                />
              </label>
              <label className="flex items-center gap-1">
                To
                <input
                  type="date"
                  value={pnlTo}
                  onChange={(e) => setPnlTo(e.target.value)}
                  className={selectClass}
                />
              </label>
              <select
                value={pnlStoreId}
                onChange={(e) => setPnlStoreId(e.target.value)}
                className={selectClass}
              >
                <option value="">Consolidated</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={busy || !pnlFrom || !pnlTo}
              onClick={() =>
                run(
                  () =>
                    post("/api/documents", {
                      entityType: "PNL_REPORT",
                      params: {
                        from: pnlFrom,
                        to: pnlTo,
                        ...(pnlStoreId ? { storeId: pnlStoreId } : {}),
                      },
                    }),
                  "P&L report PDF requested.",
                )
              }
              className={buttonClass}
            >
              Generate P&amp;L PDF
            </button>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className="text-sm text-green-700">{message}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">{error}</p>
      )}

      <div className="rounded border">
        {documents.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-gray-500">
            No documents yet — generate one above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Requested
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Type
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Subject
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Status
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {documents.map((doc) => (
                  <tr key={doc.id} className="border-b align-middle last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-500">
                      {new Date(doc.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      {DOCUMENT_TYPE_LABELS[doc.entityType] ?? doc.entityType}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">{describe(doc)}</td>
                    <td className="px-3 py-2 text-sm">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusStyle[doc.status]}`}>
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <div className="flex justify-end gap-2">
                        {doc.status === "GENERATED" && (
                          <a
                            href={`/api/documents/${doc.id}/download`}
                            className="rounded border px-2 py-0.5 text-xs"
                          >
                            Download
                          </a>
                        )}
                        {doc.status === "FAILED" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => post(`/api/documents/${doc.id}/generate`),
                                "Document re-generation requested.",
                              )
                            }
                            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
