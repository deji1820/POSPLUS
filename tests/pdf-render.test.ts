/**
 * PDF renderers (SPEC.md §20, issue #32): all three document types render
 * through @react-pdf/renderer to real PDF bytes. These are pure render smoke
 * tests — no Prisma, no storage — pinning that a full data fixture produces
 * a structurally valid PDF (magic bytes + sane size) for each template,
 * including the P&L paths with incomplete cost data and a comparison column.
 */
import { describe, expect, it } from "vitest";

import type { PnlPeriod } from "@/lib/finance/pnl";
import { PayslipPdf, type PayslipPdfData } from "@/lib/pdf/payslip";
import { PnlPdf, type PnlPdfData } from "@/lib/pdf/pnl";
import { PoPdf, type PoPdfData } from "@/lib/pdf/po";
import { renderPdf } from "@/lib/pdf/render";

function expectPdf(buffer: Buffer) {
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(buffer.length).toBeGreaterThan(500);
}

const PO_DATA: PoPdfData = {
  organizationName: "Acme Restaurants",
  number: "PO-1001",
  status: "APPROVED",
  supplierName: "Metro Foods",
  supplierContact: "orders@metrofoods.example",
  warehouseName: "Downtown Warehouse",
  currency: "USD",
  submittedAt: "2026-09-01T09:00:00Z",
  approvedAt: "2026-09-02T14:30:00Z",
  lines: [
    { label: "Flour — 25kg bag", sku: "FLR-25", quantity: "10", unitPrice: "18.50", lineTotal: "185.00" },
    { label: "Olive oil — 5L tin", sku: null, quantity: "4", unitPrice: "42.00", lineTotal: "168.00" },
  ],
  subtotal: "353.00",
  total: "353.00",
  generatedAt: "2026-09-10T00:00:00Z",
};

const PAYSLIP_DATA: PayslipPdfData = {
  organizationName: "Acme Restaurants",
  employeeName: "Sam Rivera",
  employeeEmail: "sam@example.com",
  periodName: "August 2026",
  periodStart: "2026-08-01T00:00:00Z",
  periodEnd: "2026-08-31T00:00:00Z",
  currency: "USD",
  regularHours: "160",
  overtimeHours: "8",
  gross: "3200.00",
  deductions: "480.00",
  net: "2720.00",
  adjustmentsNote: null,
  runStatus: "POSTED",
  generatedAt: "2026-09-10T00:00:00Z",
};

function period(overrides: Partial<PnlPeriod> = {}): PnlPeriod {
  return {
    from: "2026-08-01T00:00:00Z",
    to: "2026-08-31T23:59:59Z",
    sales: "52000.00",
    refunds: "-1200.00",
    adjustments: "0.00",
    netRevenue: "50800.00",
    cogs: "-20300.00",
    costDataComplete: true,
    grossProfit: "30500.00",
    operatingExpenses: [
      { accountId: "acc-1", code: "6000", name: "Rent", amount: "-8000.00" },
      { accountId: "acc-2", code: "6100", name: "Labor", amount: "-15400.00" },
    ],
    totalOperatingExpenses: "-23400.00",
    netResult: "7100.00",
    balances: true,
    ...overrides,
  };
}

describe("PDF renderers", () => {
  it("renders a purchase order PDF", async () => {
    expectPdf(await renderPdf(PoPdf({ data: PO_DATA })));
  });

  it("renders a payslip PDF, including an adjustments note", async () => {
    expectPdf(
      await renderPdf(PayslipPdf({ data: { ...PAYSLIP_DATA, adjustmentsNote: '{"bonus": 100}' } })),
    );
  });

  it("renders a consolidated P&L PDF with a comparison column", async () => {
    const data: PnlPdfData = {
      organizationName: "Acme Restaurants",
      scopeLabel: "Consolidated",
      currency: "USD",
      period: period(),
      comparison: period({ from: "2026-07-01T00:00:00Z", to: "2026-07-31T23:59:59Z", netResult: "5400.00" }),
      costLabel: "All cost data posted",
      generatedAt: "2026-09-10T00:00:00Z",
    };
    expectPdf(await renderPdf(PnlPdf({ data })));
  });

  it("renders a store-scoped P&L with incomplete cost data (labeled, not implied)", async () => {
    const data: PnlPdfData = {
      organizationName: "Acme Restaurants",
      scopeLabel: "Downtown",
      currency: "USD",
      period: period({
        cogs: "0.00",
        costDataComplete: false,
        grossProfit: null,
        netResult: null,
      }),
      comparison: null,
      costLabel: "Costs incomplete — items missing cost at time of sale",
      generatedAt: "2026-09-10T00:00:00Z",
    };
    expectPdf(await renderPdf(PnlPdf({ data })));
  });
});
