/**
 * Document entity registry (SPEC.md §20, issue #32).
 *
 * The three supported document types map to:
 *   - the module that gates requesting/downloading them (§5 role matrix),
 *   - the BullMQ job the worker runs to render them,
 *   - the loader that fetches their org-scoped source data.
 *
 * Loaders return react-pdf element factories plus a human label; the service
 * owns storage/upload/status, so this file is the only place that knows how
 * a document type maps to its data.
 */
import { DocumentsError } from "@/lib/documents/errors";
import { getPnlReport } from "@/lib/finance/pnl";
import { PnlPdf, type PnlPdfData } from "@/lib/pdf/pnl";
import { PayslipPdf, type PayslipPdfData } from "@/lib/pdf/payslip";
import { PoPdf, type PoPdfData } from "@/lib/pdf/po";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/db";
import type { Module } from "@/lib/auth/permissions";
import type { ReactElement } from "react";
import type { DocumentProps } from "@react-pdf/renderer";

import {
  DOCUMENT_ENTITY_TYPES,
  type DocumentEntityType,
} from "@/lib/documents/catalog";

export {
  DOCUMENT_ENTITY_TYPES,
  DOCUMENT_TYPE_LABELS,
  type DocumentEntityType,
} from "@/lib/documents/catalog";

/** §5 module gate per document type. */
export const DOCUMENT_TYPE_MODULES: Record<DocumentEntityType, Module> = {
  PURCHASE_ORDER: "PURCHASING",
  PAYSLIP: "PAYROLL",
  PNL_REPORT: "FINANCE",
};

export const DOCUMENT_JOB_NAMES: Record<DocumentEntityType, string> = {
  PURCHASE_ORDER: "generate-po-pdf",
  PAYSLIP: "generate-payslip-pdf",
  PNL_REPORT: "generate-pnl-pdf",
};

export interface LoadedDocument {
  /** Element ready for renderPdf(). */
  element: ReactElement<DocumentProps>;
  /** What the document is about, e.g. "PO PO-1001" — used for messages. */
  label: string;
}

function entityTypeOf(raw: string): DocumentEntityType {
  const found = (DOCUMENT_ENTITY_TYPES as readonly string[]).find((t) => t === raw);
  if (!found) {
    throw new DocumentsError(
      400,
      "VALIDATION_ERROR",
      `Unsupported document type "${raw}". Supported: ${DOCUMENT_ENTITY_TYPES.join(", ")}.`,
    );
  }
  return found as DocumentEntityType;
}

/** Normalize + validate the caller's entity reference. */
export function parseDocumentRequest(raw: unknown): {
  entityType: DocumentEntityType;
  entityId: string | null;
  params: Record<string, string>;
} {
  const input = (raw ?? {}) as Record<string, unknown>;
  const entityType = entityTypeOf(String(input.entityType ?? ""));
  const entityId = input.entityId ? String(input.entityId) : null;
  const params: Record<string, string> = {};
  if (input.params && typeof input.params === "object") {
    for (const [k, v] of Object.entries(input.params as Record<string, unknown>)) {
      if (v !== undefined && v !== null && String(v).length > 0) params[k] = String(v);
    }
  }
  if (entityType !== "PNL_REPORT" && !entityId) {
    throw new DocumentsError(400, "VALIDATION_ERROR", "entityId is required for this document type.");
  }
  if (entityType === "PNL_REPORT" && entityId) {
    throw new DocumentsError(400, "VALIDATION_ERROR", "P&L reports take params, not an entityId.");
  }
  return { entityType, entityId, params };
}

async function orgName(orgId: string): Promise<string> {
  const org = await prisma.organization.findFirst({ where: { id: orgId }, select: { name: true, currency: true } });
  if (!org) throw new DocumentsError(404, "NOT_FOUND", "Organization not found.");
  return org.name;
}

async function orgCurrency(orgId: string): Promise<string> {
  const org = await prisma.organization.findFirst({ where: { id: orgId }, select: { currency: true } });
  if (!org) throw new DocumentsError(404, "NOT_FOUND", "Organization not found.");
  return org.currency;
}

async function loadPoPdf(orgId: string, entityId: string): Promise<LoadedDocument> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: entityId, organizationId: orgId },
    include: {
      supplier: { select: { name: true, contactEmail: true, contactPhone: true } },
      destinationWarehouse: { select: { name: true } },
      lines: { include: { variant: { include: { item: { select: { name: true } } } } }, orderBy: { id: "asc" } },
    },
  });
  if (!po) throw new DocumentsError(404, "NOT_FOUND", "Purchase order not found in this organization.");
  const currency = await orgCurrency(orgId);
  const data: PoPdfData = {
    organizationName: await orgName(orgId),
    number: po.number,
    status: po.status,
    supplierName: po.supplier.name,
    supplierContact: po.supplier.contactEmail ?? po.supplier.contactPhone,
    warehouseName: po.destinationWarehouse.name,
    currency,
    submittedAt: po.submittedAt?.toISOString() ?? null,
    approvedAt: po.approvedAt?.toISOString() ?? null,
    lines: po.lines.map((l) => {
      const qty = l.quantity.toString();
      const price = l.unitPrice.toString();
      return {
        label: `${l.variant.item.name} — ${l.variant.name}`,
        sku: l.variant.sku,
        quantity: qty,
        unitPrice: price,
        lineTotal: l.unitPrice.mul(l.quantity).toString(),
      };
    }),
    subtotal: po.subtotal.toString(),
    total: po.total.toString(),
    generatedAt: new Date().toISOString(),
  };
  return { element: PoPdf({ data }), label: `PO ${po.number}` };
}

async function loadPayslipPdf(orgId: string, entityId: string): Promise<LoadedDocument> {
  const line = await prisma.payrollLine.findFirst({
    where: { id: entityId, organizationId: orgId },
    include: {
      employee: { select: { name: true, email: true } },
      payrollRun: { include: { payrollPeriod: { select: { name: true, startDate: true, endDate: true } } } },
    },
  });
  if (!line) throw new DocumentsError(404, "NOT_FOUND", "Payslip not found in this organization.");
  const currency = await orgCurrency(orgId);
  const adjustments = line.adjustments as Record<string, unknown> | null;
  const data: PayslipPdfData = {
    organizationName: await orgName(orgId),
    employeeName: line.employee.name,
    employeeEmail: line.employee.email,
    periodName: line.payrollRun.payrollPeriod.name,
    periodStart: line.payrollRun.payrollPeriod.startDate.toISOString(),
    periodEnd: line.payrollRun.payrollPeriod.endDate.toISOString(),
    currency,
    regularHours: line.regularHours.toString(),
    overtimeHours: line.overtimeHours.toString(),
    gross: line.gross.toString(),
    deductions: line.deductions.toString(),
    net: line.net.toString(),
    adjustmentsNote: adjustments ? JSON.stringify(adjustments) : null,
    runStatus: line.payrollRun.status,
    generatedAt: new Date().toISOString(),
  };
  return {
    element: PayslipPdf({ data }),
    label: `Payslip — ${line.employee.name} — ${line.payrollRun.payrollPeriod.name}`,
  };
}

async function loadPnlPdf(orgId: string, params: Record<string, string>): Promise<LoadedDocument> {
  const report = await getPnlReport(orgId, params);
  const data: PnlPdfData = {
    organizationName: await orgName(orgId),
    scopeLabel: report.consolidated ? "Consolidated" : (report.storeId ?? "Store"),
    currency: await orgCurrency(orgId),
    period: report.period,
    comparison: report.comparison,
    costLabel: report.costLabel,
    generatedAt: new Date().toISOString(),
  };
  const from = report.period.from.slice(0, 10);
  const to = report.period.to.slice(0, 10);
  return { element: PnlPdf({ data }), label: `P&L ${from} – ${to}` };
}

/** Load + render a document of the given type to a PDF buffer. */
export async function buildDocumentPdf(input: {
  orgId: string;
  entityType: DocumentEntityType;
  entityId: string | null;
  params: Record<string, string>;
}): Promise<{ pdf: Buffer; label: string }> {
  const loaded: LoadedDocument =
    input.entityType === "PURCHASE_ORDER" && input.entityId
      ? await loadPoPdf(input.orgId, input.entityId)
      : input.entityType === "PAYSLIP" && input.entityId
        ? await loadPayslipPdf(input.orgId, input.entityId)
        : input.entityType === "PNL_REPORT"
          ? await loadPnlPdf(input.orgId, input.params)
          : (() => {
              throw new DocumentsError(400, "VALIDATION_ERROR", "entityId is required for this document type.");
            })();
  const pdf = await renderPdf(loaded.element);
  return { pdf, label: loaded.label };
}
