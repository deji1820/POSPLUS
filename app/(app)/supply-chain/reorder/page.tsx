/**
 * /supply-chain/reorder — reorder suggestion workflow (SPEC.md §12, issue #17).
 * Lists PENDING suggestions from the nightly recalculation job (#33) with the
 * sales-velocity inputs behind each one; accepting creates a Draft Purchase
 * Order (§13 starts at DRAFT) and dismissing clears the row. Both decisions
 * are audited (§17). INVENTORY module roles (§5): Owner / Store Manager /
 * Warehouse Staff.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { listPendingSuggestions } from "@/lib/reorder/suggestions";

import { ReorderManager } from "./reorder-manager";

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Reorder Suggestions</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

export default async function ReorderPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) return deny(error.message);
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "INVENTORY")) {
    return deny("Your role does not permit access to the inventory module.");
  }

  const [suggestions, suppliers] = await Promise.all([
    listPendingSuggestions(ctx.orgId),
    prisma.supplier.findMany({
      where: { organizationId: ctx.orgId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, leadTimeDays: true },
    }),
  ]);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Reorder Suggestions</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Nightly suggestions from the reorder engine (§12: sales velocity ×
          lead time + safety stock). Accepting one creates a draft purchase
          order; every suggestion shows the inputs behind it.
        </p>
      </div>
      <ReorderManager suggestions={suggestions} suppliers={suppliers} />
    </section>
  );
}
