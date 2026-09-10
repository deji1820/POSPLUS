"use server";

import {
  runSettingsMutation,
  toSettingsState,
  type SettingsActionState,
} from "@/lib/settings";
import {
  createDeduction,
  createPayrollPeriod,
  deductionInputSchema,
  payrollPeriodInputSchema,
  updateDeduction,
  updateDeductionSchema,
} from "@/lib/settings/payroll";
import { AUDIT_ACTIONS } from "@/lib/audit/writer";

/** Create a statutory deduction rule. */
export async function createDeductionAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        name: formData.get("name"),
        rate: formData.get("rate"),
        fixedAmount: formData.get("fixedAmount"),
        effectiveFrom: formData.get("effectiveFrom"),
      },
      deductionInputSchema,
      async (ctx, data) => {
        const created = await createDeduction(ctx.orgId, data);
        return {
          message: `Deduction "${created.name}" added.`,
          revalidate: ["/settings/payroll-rules"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.PAYROLL_DEDUCTION_CREATED,
            entityType: "StatutoryDeductionRule",
            entityId: created.id,
            afterJson: created,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Update a statutory deduction rule. */
export async function updateDeductionAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        id: formData.get("id"),
        name: formData.get("name"),
        rate: formData.get("rate"),
        fixedAmount: formData.get("fixedAmount"),
        effectiveFrom: formData.get("effectiveFrom"),
      },
      updateDeductionSchema,
      async (ctx, data) => {
        const { before, after } = await updateDeduction(ctx.orgId, data);
        return {
          message: `Deduction "${after.name}" updated.`,
          revalidate: ["/settings/payroll-rules"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.PAYROLL_DEDUCTION_UPDATED,
            entityType: "StatutoryDeductionRule",
            entityId: after.id,
            beforeJson: before,
            afterJson: after,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Create a payroll period. */
export async function createPayrollPeriodAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        name: formData.get("name"),
        startDate: formData.get("startDate"),
        endDate: formData.get("endDate"),
      },
      payrollPeriodInputSchema,
      async (ctx, data) => {
        const created = await createPayrollPeriod(ctx.orgId, data);
        return {
          message: `Payroll period "${created.name}" created.`,
          revalidate: ["/settings/payroll-rules"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.PAYROLL_PERIOD_CREATED,
            entityType: "PayrollPeriod",
            entityId: created.id,
            afterJson: created,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

export type { SettingsActionState };
