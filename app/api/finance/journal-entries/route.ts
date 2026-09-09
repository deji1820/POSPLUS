/**
 * GET /api/finance/journal-entries — filtered journal-entry list
 * (SPEC.md §6 "/finance/ledger", §7 API outline). Owner/Accountant only
 * (FINANCE module, §5). Filters: period (fiscalPeriodId), storeId,
 * accountId (entries with a line on the account), source
 * (receipt|refund|reversal|manual). Posted entries expose no mutation here —
 * §7: "Never expose arbitrary journal-line mutation after posting."
 */
import { NextResponse } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { FinanceError } from "@/lib/finance/errors";
import { listJournalEntries } from "@/lib/finance/ledger";

export const runtime = "nodejs";

export const GET = withAuth({ module: "FINANCE" }, async (req, ctx) => {
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  try {
    const entries = await listJournalEntries(ctx.orgId, query);
    return NextResponse.json(ok({ entries }));
  } catch (error) {
    if (error instanceof FinanceError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
