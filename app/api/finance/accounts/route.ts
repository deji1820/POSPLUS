/**
 * GET /api/finance/accounts — chart of accounts for the caller's org.
 * POST /api/finance/accounts — create an account (SPEC.md §7).
 *
 * Owner/Accountant only (FINANCE module, §5). `code` is unique per org and
 * immutable after creation; invalid input surfaces as operator-safe §19
 * envelopes (FinanceError), never raw driver errors.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { createAccount, listAccounts } from "@/lib/finance/accounts";
import { FinanceError } from "@/lib/finance/errors";

export const runtime = "nodejs";

export const GET = withAuth({ module: "FINANCE" }, async (_req, ctx) => {
  const accounts = await listAccounts(ctx.orgId);
  return NextResponse.json(ok({ accounts }));
});

export const POST = withAuth({ module: "FINANCE" }, async (req: NextRequest, ctx) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(apiError("VALIDATION_ERROR", "Request body must be JSON."), {
      status: 400,
    });
  }
  try {
    const account = await createAccount(ctx.orgId, body);
    return NextResponse.json(ok({ account }), { status: 201 });
  } catch (error) {
    if (error instanceof FinanceError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
