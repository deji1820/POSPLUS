/**
 * /supply-chain/inventory — balances + movement ledger (SPEC.md §6, issue #16).
 * INVENTORY module roles (§5): Owner / Store Manager / Warehouse Staff, with
 * store/warehouse-scoped roles seeing only their assigned rows. Filters ride
 * on the URL (GET form) so views are linkable; every balance shown is the sum
 * of the movements below it — the acceptance invariant of this issue.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import {
  listInventoryBalances,
  listInventoryMovements,
  type BalanceFilters,
  type MovementFilters,
} from "@/lib/inventory/read";
import { prisma } from "@/lib/db";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function accessDenied(title: string, message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return accessDenied("Inventory", error.message);
    }
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "INVENTORY")) {
    return accessDenied(
      "Inventory",
      "Your role does not permit access to the inventory module.",
    );
  }

  const scope = { storeIds: ctx.storeIds, warehouseIds: ctx.warehouseIds };
  const balanceFilters: BalanceFilters = {
    storeId: first(params.storeId),
    warehouseId: first(params.warehouseId),
    itemId: first(params.itemId),
    variantId: first(params.variantId),
    lowStock: first(params.lowStock) === "1" ? "1" : undefined,
  };
  const movementFilters: MovementFilters = {
    storeId: first(params.storeId),
    warehouseId: first(params.warehouseId),
    itemId: first(params.itemId),
    variantId: first(params.variantId),
    type: first(params.type) as MovementFilters["type"],
    limit: 50,
  };

  const [balances, movements, stores, warehouses, items] = await Promise.all([
    listInventoryBalances(ctx.orgId, scope, balanceFilters),
    listInventoryMovements(ctx.orgId, scope, movementFilters),
    prisma.store.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.warehouse.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.item.findMany({
      where: { organizationId: ctx.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const selectClass =
    "rounded border bg-white px-2 py-1 text-sm dark:bg-gray-900";
  const thClass = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";
  const tdClass = "px-3 py-2 text-sm";

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Inventory</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          On-hand balances per warehouse and the movement ledger behind them.
          Every balance change is an immutable movement — the two always
          reconcile.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded border p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Store
          <select name="storeId" defaultValue={balanceFilters.storeId ?? ""} className={selectClass}>
            <option value="">All stores</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>{store.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Warehouse
          <select name="warehouseId" defaultValue={balanceFilters.warehouseId ?? ""} className={selectClass}>
            <option value="">All warehouses</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Item
          <select name="itemId" defaultValue={balanceFilters.itemId ?? ""} className={selectClass}>
            <option value="">All items</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Movement type
          <select name="type" defaultValue={movementFilters.type ?? ""} className={selectClass}>
            <option value="">All types</option>
            {["SALE", "REFUND", "RECEIPT", "TRANSFER_OUT", "TRANSFER_IN", "PRODUCTION_CONSUME", "PRODUCTION_OUTPUT", "ADJUSTMENT"].map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            name="lowStock"
            value="1"
            defaultChecked={balanceFilters.lowStock === "1"}
          />
          Low stock only
        </label>
        <button
          type="submit"
          className="rounded bg-black px-3 py-1 text-sm text-white dark:bg-white dark:text-black"
        >
          Filter
        </button>
        <a href="/supply-chain/inventory" className="text-sm text-gray-500 underline">
          Reset
        </a>
      </form>

      <div className="rounded border">
        <h2 className="border-b px-3 py-2 text-sm font-semibold">Balances</h2>
        {balances.length === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-500">
            No balances match these filters. Stock appears here once receipts,
            refunds, or inventory snapshots project movements.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className={thClass}>Item</th>
                  <th className={thClass}>Variant</th>
                  <th className={thClass}>Warehouse</th>
                  <th className={`${thClass} text-right`}>On hand</th>
                  <th className={`${thClass} text-right`}>Reserved</th>
                  <th className={`${thClass} text-right`}>Reorder point</th>
                  <th className={`${thClass} text-right`}>Suggested reorder</th>
                  <th className={thClass}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {balances.map((row) => (
                  <tr key={`${row.warehouse.id}:${row.variant.id}`}>
                    <td className={tdClass}>{row.item.name}</td>
                    <td className={tdClass}>{row.variant.name}</td>
                    <td className={tdClass}>
                      {row.warehouse.name}
                      {row.warehouse.storeName ? ` (${row.warehouse.storeName})` : ""}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums`}>{row.onHand}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{row.reserved}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{row.reorderPoint ?? "—"}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{row.suggestedReorderQty ?? "—"}</td>
                    <td className={tdClass}>
                      {row.lowStock ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900 dark:text-red-200">
                          Low stock
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded border">
        <h2 className="border-b px-3 py-2 text-sm font-semibold">Movements</h2>
        {movements.entries.length === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-500">
            No movements recorded yet for these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className={thClass}>When</th>
                  <th className={thClass}>Type</th>
                  <th className={thClass}>Item</th>
                  <th className={thClass}>Variant</th>
                  <th className={thClass}>Warehouse</th>
                  <th className={`${thClass} text-right`}>Qty</th>
                  <th className={thClass}>Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {movements.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className={tdClass}>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className={tdClass}>{entry.type}</td>
                    <td className={tdClass}>{entry.variant.itemName}</td>
                    <td className={tdClass}>{entry.variant.name}</td>
                    <td className={tdClass}>
                      {entry.warehouse.name}
                      {entry.warehouse.storeName ? ` (${entry.warehouse.storeName})` : ""}
                    </td>
                    <td className={`${tdClass} text-right tabular-nums ${entry.quantityDelta.startsWith("-") ? "text-red-700" : "text-green-700"}`}>
                      {entry.quantityDelta}
                    </td>
                    <td className={tdClass}>
                      {entry.referenceType ? `${entry.referenceType}${entry.referenceId ? ` · ${entry.referenceId.slice(0, 8)}` : ""}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
