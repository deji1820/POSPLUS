/**
 * GET /api/finance/reports/pnl — P&L report (SPEC.md §7 finance API outline,
 * issue #13). Owner/Accountant only (FINANCE module, §5).
 *
 * Query: storeId (omit for consolidated), from/to (ISO date or datetime;
 * default current calendar month), compare=1 (preceding equal-length period).
 * The report is computed from POSTED journal lines, so it balances against
 * the ledger by construction (§11 acceptance).
 *
 * PDF export is intentionally absent here: server-side generation + object
 * storage lands with the document pipeline (SPEC §20, Sprint 5) — the UI
 * links forward to it instead of offering a broken export.
 */
import { NextResponse } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { FinanceError } from "@/lib/finance/errors";
import { getPnlReport } from "@/lib/finance/pnl";

export const runtime = "nodejs";

export const GET = withAuth({ module: "FINANCE" }, async (req, ctx) => {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const report = await getPnlReport(ctx.orgId, query);
    return NextResponse.json(ok({ report }));
  } catch (error) {
    if (error instanceof FinanceError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
