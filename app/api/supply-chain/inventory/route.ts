/**
 * GET /api/supply-chain/inventory — balance list (SPEC.md §6, issue #16).
 * INVENTORY module roles (§5): Owner / Store Manager / Warehouse Staff;
 * store/warehouse-scoped roles only see balances inside their scope.
 *
 * Query: storeId, warehouseId, itemId, variantId, lowStock=1.
 */
import { NextResponse } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { InventoryError } from "@/lib/inventory/errors";
import { listInventoryBalances } from "@/lib/inventory/read";

export const runtime = "nodejs";

export const GET = withAuth({ module: "INVENTORY" }, async (req, ctx) => {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const balances = await listInventoryBalances(ctx.orgId, {
      storeIds: ctx.storeIds,
      warehouseIds: ctx.warehouseIds,
    }, query);
    return NextResponse.json(ok({ balances }));
  } catch (error) {
    if (error instanceof InventoryError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
