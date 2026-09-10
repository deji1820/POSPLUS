/**
 * /settings/payroll-rules — SPEC.md §6 "Settings → Payroll rules" and the
 * post-sync checklist's "payroll rules" item. Configure statutory deduction
 * rules (rate and/or fixed amount, effective-from date) and payroll periods.
 * Owner-only; every change is audited (§17).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listDeductions, listPayrollPeriods } from "@/lib/settings/payroll";

import { PayrollRulesManager } from "./payroll-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Payroll Rules</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function PayrollRulesSettingsPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) return deny(error.message);
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "SETTINGS")) {
    return deny("Your role does not permit access to organization settings.");
  }

  const [deductions, periods] = await Promise.all([
    listDeductions(ctx.orgId),
    listPayrollPeriods(ctx.orgId),
  ]);

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Payroll Rules</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Statutory deductions and payroll periods — the org-level setup applied when payroll runs.
          Changes are recorded in the audit log.
        </p>
      </div>
      <PayrollRulesManager deductions={deductions} periods={periods} />
    </section>
  );
}
