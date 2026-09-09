/**
 * GET /api/finance/journal-entries/:id — entry detail with account lines,
 * debit/credit totals, source receipt/refund link, and reversal linkage
 * (SPEC.md §6 "/finance/ledger" detail, §7 API outline). Org-scoped: a
 * missing or cross-tenant id is a plain 404.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import type { SessionContext } from "@/lib/auth/session-context";
import { FinanceError } from "@/lib/finance/errors";
import { getJournalEntry } from "@/lib/finance/ledger";

export const runtime = "nodejs";

export const GET = withAuth(
  { module: "FINANCE" },
  async (_req: NextRequest, params: { id: string }, ctx: SessionContext) => {
    try {
      const entry = await getJournalEntry(ctx.orgId, params.id);
      return NextResponse.json(ok({ entry }));
    } catch (error) {
      if (error instanceof FinanceError) {
        return NextResponse.json(apiError(error.code, error.message), { status: error.status });
      }
      throw error;
    }
  },
);
