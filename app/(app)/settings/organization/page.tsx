/**
 * /settings/organization — SPEC.md §6 "Settings → Organization".
 * Edit the tenant's core config (name, currency, timezone). Owner-only via
 * the SETTINGS module guard; changes are audited (§17).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { getOrganizationSettings } from "@/lib/settings/organization";

import { OrganizationForm } from "./organization-form";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Organization</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function OrganizationSettingsPage() {
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

  const org = await getOrganizationSettings(ctx.orgId);

  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Organization</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Core tenant configuration. Changes are recorded in the audit log.
        </p>
      </div>
      <div className="rounded border p-4">
        <OrganizationForm initial={org} />
      </div>
    </section>
  );
}
