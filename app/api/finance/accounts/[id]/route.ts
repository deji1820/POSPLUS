/**
 * PATCH /api/finance/accounts/:id — update name/type/active/store
 * applicability (SPEC.md §7). The account `code` is immutable (create-only)
 * so posted journal history stays explainable; deactivation replaces
 * deletion.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import type { SessionContext } from "@/lib/auth/session-context";
import { updateAccount } from "@/lib/finance/accounts";
import { FinanceError } from "@/lib/finance/errors";

export const runtime = "nodejs";

export const PATCH = withAuth(
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
      const account = await updateAccount(ctx.orgId, params.id, body);
      return NextResponse.json(ok({ account }));
    } catch (error) {
      if (error instanceof FinanceError) {
        return NextResponse.json(apiError(error.code, error.message), { status: error.status });
      }
      throw error;
    }
  },
);
