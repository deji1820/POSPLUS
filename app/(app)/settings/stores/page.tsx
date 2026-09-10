/**
 * /settings/stores — SPEC.md §6 "Settings → Stores".
 * List the tenant's stores and create/edit them. Owner-only (SETTINGS
 * module); every create/update is audited (§17).
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { listStores } from "@/lib/settings/stores";

import { StoresManager } from "./stores-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Stores</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function StoresSettingsPage() {
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

  const stores = await listStores(ctx.orgId);

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Stores</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Retail locations. Stores synced from Loyverse keep their store id; you can also add
          manual stores. Changes are recorded in the audit log.
        </p>
      </div>
      <StoresManager initialStores={stores} />
    </section>
  );
}
