/**
 * /settings/dashboard — SPEC.md §6 Management Dashboard Modes. Save the
 * current user's default dashboard context (mode, scope, period) so the
 * management dashboard opens with their last view. Owner-only; audited.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { getDashboardPreference } from "@/lib/settings/dashboard-preferences";

import { DashboardPreferenceForm } from "./dashboard-preference-form";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Dashboard Preferences</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function DashboardSettingsPage() {
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

  const preference = await getDashboardPreference(ctx.orgId, ctx.userId);

  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Preferences</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Your default view for the management dashboard. Changes are recorded in the audit log.
        </p>
      </div>
      <div className="rounded border p-4">
        <DashboardPreferenceForm initial={preference} />
      </div>
    </section>
  );
}
