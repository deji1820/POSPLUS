/**
 * POST /api/finance/journal-entries/:id/reverse — reversal workflow
 * (SPEC.md §6 "/finance/ledger", §7 API outline, §8 invariants). Creates a
 * NEW POSTED entry that mirrors the original's lines with debit/credit
 * swapped, linked via reversalOfId. Posted entries are never mutated or
 * deleted. Body: { reason: string }.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import type { SessionContext } from "@/lib/auth/session-context";
import { FinanceError } from "@/lib/finance/errors";
import { reverseEntry } from "@/lib/finance/ledger";

export const runtime = "nodejs";

export const POST = withAuth(
  { module: "FINANCE" },
  async (req: NextRequest, params: { id: string }, ctx: SessionContext) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(apiError("VALIDATION_ERROR", "Request body must be JSON."), {
        status: 400,
      });
    }
    try {
      const result = await reverseEntry(ctx.orgId, params.id, body, ctx.userId);
      return NextResponse.json(ok(result), { status: 201 });
    } catch (error) {
      if (error instanceof FinanceError) {
        return NextResponse.json(apiError(error.code, error.message), { status: error.status });
      }
      throw error;
    }
  },
);
