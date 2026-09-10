/**
 * Document type catalog (SPEC.md §20, issue #32) — the parts of the document
 * registry that both server and client need, with NO server-only imports.
 * The manager UI (a client component) imports labels/types from here; the
 * module gates and job names stay server-side in lib/documents/entities.ts.
 */
export const DOCUMENT_ENTITY_TYPES = ["PURCHASE_ORDER", "PAYSLIP", "PNL_REPORT"] as const;
export type DocumentEntityType = (typeof DOCUMENT_ENTITY_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentEntityType, string> = {
  PURCHASE_ORDER: "Purchase order",
  PAYSLIP: "Payslip",
  PNL_REPORT: "P&L report",
};
