/**
 * GET /api/supply-chain/inventory/movements — movement ledger (SPEC.md §6,
 * issue #16). Same module/scope rules as the balance list. Cursor-paginated,
 * newest first.
 *
 * Query: storeId, warehouseId, itemId, variantId, type, from, to, cursor, limit (≤200).
 */
import { NextResponse } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { InventoryError } from "@/lib/inventory/errors";
import { listInventoryMovements } from "@/lib/inventory/read";

export const runtime = "nodejs";

export const GET = withAuth({ module: "INVENTORY" }, async (req, ctx) => {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const result = await listInventoryMovements(ctx.orgId, {
      storeIds: ctx.storeIds,
      warehouseIds: ctx.warehouseIds,
    }, query);
    return NextResponse.json(ok(result));
  } catch (error) {
    if (error instanceof InventoryError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
