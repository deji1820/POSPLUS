/**
 * /documents — SPEC.md §7 documents outline, §20, issue #32. The org's
 * generated documents: request a PO / payslip / P&L PDF, watch it render on
 * the documents queue, download it. Each section is gated by the document
 * type's module (§5 role matrix): PURCHASING, PAYROLL, FINANCE. The actual
 * gating happens again in the API routes — this page only hides sections a
 * role cannot use.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listDocuments } from "@/lib/documents";
import { prisma } from "@/lib/db";

import {
  DocumentsManager,
  type DocumentListItem,
  type PayslipOption,
  type PoOption,
  type StoreOption,
} from "./documents-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Documents</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function DocumentsPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) return deny(error.message);
    throw error;
  }

  const canPo = hasModuleAccess(ctx.role, "PURCHASING");
  const canPayslip = hasModuleAccess(ctx.role, "PAYROLL");
  const canPnl = hasModuleAccess(ctx.role, "FINANCE");
  if (!canPo && !canPayslip && !canPnl) {
    return deny("Your role does not permit generating or viewing documents.");
  }

  const [rows, poRows, payslipRows, storeRows] = await Promise.all([
    listDocuments(ctx.orgId),
    canPo
      ? prisma.purchaseOrder.findMany({
          where: { organizationId: ctx.orgId },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            number: true,
            status: true,
            supplier: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    canPayslip
      ? prisma.payrollLine.findMany({
          where: { organizationId: ctx.orgId },
          orderBy: { id: "desc" },
          take: 50,
          select: {
            id: true,
            payrollRun: {
              select: {
                status: true,
                payrollPeriod: { select: { name: true } },
              },
            },
            employee: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    canPnl
      ? prisma.store.findMany({
          where: { organizationId: ctx.orgId },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const documents: DocumentListItem[] = rows.map((row) => ({
    id: row.id,
    entityType: row.entityType as DocumentListItem["entityType"],
    entityId: row.entityId,
    status: row.status as DocumentListItem["status"],
    storageKey: row.storageKey,
    checksum: row.checksum,
    createdAt: row.createdAt.toISOString(),
    paramsJson: (row.paramsJson as Record<string, unknown> | null) ?? null,
  }));

  const poOptions: PoOption[] = poRows.map((po) => ({
    id: po.id,
    number: po.number,
    supplierName: po.supplier.name,
    status: po.status,
  }));

  const payslipOptions: PayslipOption[] = payslipRows.map((line) => ({
    id: line.id,
    employeeName: line.employee.name,
    periodName: line.payrollRun.payrollPeriod.name,
    runStatus: line.payrollRun.status,
  }));

  const stores: StoreOption[] = storeRows;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Documents</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Server-generated PDFs — purchase orders, payslips, and P&amp;L reports — stored in the
          organization&apos;s document storage and downloadable here.
        </p>
      </div>
      <DocumentsManager
        documents={documents}
        poOptions={poOptions}
        payslipOptions={payslipOptions}
        stores={stores}
        canPo={canPo}
        canPayslip={canPayslip}
        canPnl={canPnl}
      />
    </section>
  );
}
