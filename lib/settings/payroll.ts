/**
 * Payroll rules use-cases (SPEC.md §6 "Settings → Payroll rules": pay rates,
 * pay period, statutory deduction settings; and the post-sync checklist's
 * "payroll rules" item). Covers the ORG-level configuration an Owner sets up
 * before running payroll: statutory deduction rules and payroll periods.
 * (Per-employee pay rates live on /workforce/employees — EmployeePayRule is
 * employee-scoped, not org settings.) Org scoped; SETTINGS module only.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { SettingsError, validationError } from "@/lib/settings/errors";

// ---------------------------------------------------------------------------
// Statutory deduction rules
// ---------------------------------------------------------------------------

export const deductionInputSchema = z
  .object({
    name: z.string().trim().min(1, "Deduction name is required.").max(200),
    /** Percentage rate (e.g. 5 for 5%). Used when fixedAmount is not set. */
    rate: z
      .string()
      .trim()
      .optional()
      .or(z.literal("").transform(() => undefined))
      .transform((v) => (v === undefined ? undefined : v)),
    fixedAmount: z
      .string()
      .trim()
      .optional()
      .or(z.literal("").transform(() => undefined))
      .transform((v) => (v === undefined ? undefined : v)),
    effectiveFrom: z.string().trim().min(1, "Effective-from date is required."),
  })
  .superRefine((val, ctx) => {
    const hasRate = val.rate !== undefined && val.rate !== "";
    const hasFixed = val.fixedAmount !== undefined && val.fixedAmount !== "";
    if (!hasRate && !hasFixed) {
      ctx.addIssue({ code: "custom", message: "Set a rate or a fixed amount.", path: ["rate"] });
    }
    if (hasRate) {
      const n = Number(val.rate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({ code: "custom", message: "Rate must be 0–100.", path: ["rate"] });
      }
    }
    if (hasFixed) {
      const n = Number(val.fixedAmount);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: "custom", message: "Fixed amount must be 0 or more.", path: ["fixedAmount"] });
      }
    }
  });
export type DeductionInput = z.infer<typeof deductionInputSchema>;

export const updateDeductionSchema = deductionInputSchema.extend({ id: z.string().min(1) });
export type UpdateDeductionInput = z.infer<typeof updateDeductionSchema>;

export interface DeductionSummary {
  id: string;
  name: string;
  rate: string | null;
  fixedAmount: string | null;
  effectiveFrom: string; // ISO
}

export async function listDeductions(orgId: string): Promise<DeductionSummary[]> {
  const rows = await prisma.statutoryDeductionRule.findMany({
    where: { organizationId: orgId },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: r.rate ? r.rate.toString() : null,
    fixedAmount: r.fixedAmount ? r.fixedAmount.toString() : null,
    effectiveFrom: r.effectiveFrom.toISOString(),
  }));
}

export async function createDeduction(
  orgId: string,
  input: DeductionInput,
): Promise<DeductionSummary> {
  const effectiveFrom = new Date(input.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw validationError("Effective-from date is not a valid date.");
  }
  const rate = input.rate !== undefined && input.rate !== "" ? input.rate : null;
  const fixedAmount =
    input.fixedAmount !== undefined && input.fixedAmount !== "" ? input.fixedAmount : null;
  const row = await prisma.statutoryDeductionRule.create({
    data: {
      organizationId: orgId,
      name: input.name,
      rate,
      fixedAmount,
      effectiveFrom,
    },
  });
  return {
    id: row.id,
    name: row.name,
    rate: row.rate ? row.rate.toString() : null,
    fixedAmount: row.fixedAmount ? row.fixedAmount.toString() : null,
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
}

export async function updateDeduction(
  orgId: string,
  input: UpdateDeductionInput,
): Promise<{ before: DeductionSummary; after: DeductionSummary }> {
  const existing = await prisma.statutoryDeductionRule.findFirst({
    where: { id: input.id, organizationId: orgId },
  });
  if (!existing) {
    throw new SettingsError(404, "NOT_FOUND", "Deduction rule not found.");
  }
  const effectiveFrom = new Date(input.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw validationError("Effective-from date is not a valid date.");
  }
  const rate = input.rate !== undefined && input.rate !== "" ? input.rate : null;
  const fixedAmount =
    input.fixedAmount !== undefined && input.fixedAmount !== "" ? input.fixedAmount : null;
  const row = await prisma.statutoryDeductionRule.update({
    where: { id: input.id },
    data: { name: input.name, rate, fixedAmount, effectiveFrom },
  });
  const toSummary = (r: typeof row): DeductionSummary => ({
    id: r.id,
    name: r.name,
    rate: r.rate ? r.rate.toString() : null,
    fixedAmount: r.fixedAmount ? r.fixedAmount.toString() : null,
    effectiveFrom: r.effectiveFrom.toISOString(),
  });
  return { before: toSummary(existing), after: toSummary(row) };
}

// ---------------------------------------------------------------------------
// Payroll periods
// ---------------------------------------------------------------------------

export const payrollPeriodInputSchema = z
  .object({
    name: z.string().trim().min(1, "Period name is required.").max(200),
    startDate: z.string().trim().min(1, "Start date is required."),
    endDate: z.string().trim().min(1, "End date is required."),
  })
  .superRefine((val, ctx) => {
    const start = new Date(val.startDate);
    const end = new Date(val.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      ctx.addIssue({ code: "custom", message: "Dates must be valid.", path: ["startDate"] });
    } else if (end < start) {
      ctx.addIssue({ code: "custom", message: "End date must be on or after start date.", path: ["endDate"] });
    }
  });
export type PayrollPeriodInput = z.infer<typeof payrollPeriodInputSchema>;

export interface PayrollPeriodSummary {
  id: string;
  name: string;
  startDate: string; // ISO
  endDate: string; // ISO
}

export async function listPayrollPeriods(orgId: string): Promise<PayrollPeriodSummary[]> {
  const rows = await prisma.payrollPeriod.findMany({
    where: { organizationId: orgId },
    orderBy: { startDate: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startDate: r.startDate.toISOString(),
    endDate: r.endDate.toISOString(),
  }));
}

export async function createPayrollPeriod(
  orgId: string,
  input: PayrollPeriodInput,
): Promise<PayrollPeriodSummary> {
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw validationError("Invalid period dates.");
  }
  // Reject an exact name+range duplicate (idempotent re-submit).
  const clash = await prisma.payrollPeriod.findFirst({
    where: { organizationId: orgId, name: input.name, startDate: start, endDate: end },
    select: { id: true },
  });
  if (clash) {
    throw validationError("A period with this name and date range already exists.");
  }
  const row = await prisma.payrollPeriod.create({
    data: { organizationId: orgId, name: input.name, startDate: start, endDate: end },
  });
  return {
    id: row.id,
    name: row.name,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
  };
}
