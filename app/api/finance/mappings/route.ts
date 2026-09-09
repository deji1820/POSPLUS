/**
 * GET /api/finance/mappings — current GL mappings for the caller's org.
 * PUT /api/finance/mappings — replace the org's entire mapping set
 * (SPEC.md §7). One PUT = one transaction; ANY invalid row rejects the whole
 * set with an operator-safe §19 error so auto-posting (#11) never reads a
 * silently partial configuration.
 */
import { NextResponse, type NextRequest } from "next/server";

import { ok, apiError } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { FinanceError } from "@/lib/finance/errors";
import { listMappings, replaceMappings } from "@/lib/finance/mappings";

export const runtime = "nodejs";

export const GET = withAuth({ module: "FINANCE" }, async (_req, ctx) => {
  const mappings = await listMappings(ctx.orgId);
  return NextResponse.json(ok({ mappings }));
});

export const PUT = withAuth({ module: "FINANCE" }, async (req: NextRequest, ctx) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      apiError("VALIDATION_ERROR", "Request body must be JSON: { mappings: [...] }."),
      { status: 400 },
    );
  }
  try {
    const mappings = await replaceMappings(ctx.orgId, body);
    return NextResponse.json(ok({ mappings }));
  } catch (error) {
    if (error instanceof FinanceError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    throw error;
  }
});
