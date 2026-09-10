/**
 * /settings/roles — SPEC.md §6 "Settings → Users and roles", §5 RBAC, and the
 * post-sync checklist's "roles/permissions" item. List the org's members,
 * invite users by email, change roles, activate/deactivate, and narrow
 * store/warehouse scope for the scoped roles. Owner-only; every change is
 * audited (§17 "organization and role changes").
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listStores } from "@/lib/settings/stores";
import { listMemberships } from "@/lib/settings/members";
import { listWarehouses } from "@/lib/settings/warehouses";

import { MembersManager } from "./members-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Users &amp; Roles</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function RolesSettingsPage() {
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

  const [members, stores, warehouses] = await Promise.all([
    listMemberships(ctx.orgId),
    listStores(ctx.orgId),
    listWarehouses(ctx.orgId),
  ]);

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Users &amp; Roles</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Manage who has access and what they can do. Store Managers can be narrowed to specific
          stores and Warehouse Staff to specific warehouses. Changes are recorded in the audit log.
        </p>
      </div>
      <MembersManager
        initialMembers={members}
        stores={stores.map((s) => ({ id: s.id, name: s.name }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: `${w.code} · ${w.name}` }))}
      />
    </section>
  );
}
