/**
 * /settings/warehouses — SPEC.md §6 "Settings → Warehouses" and the post-sync
 * setup checklist's "warehouses/locations" item. List and create/edit
 * warehouses (optionally linked to a store). Owner-only; audited (§17).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listStores } from "@/lib/settings/stores";
import { listWarehouses } from "@/lib/settings/warehouses";

import { WarehousesManager } from "./warehouses-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Warehouses</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function WarehousesSettingsPage() {
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

  const [warehouses, stores] = await Promise.all([listWarehouses(ctx.orgId), listStores(ctx.orgId)]);

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Warehouses</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Stock locations. A warehouse may be linked to a store or stand alone (e.g. a commissary
          or central stockroom). Changes are recorded in the audit log.
        </p>
      </div>
      <WarehousesManager
        initialWarehouses={warehouses}
        stores={stores.map((s) => ({ id: s.id, name: s.name }))}
      />
    </section>
  );
}
