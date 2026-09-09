/**
 * GET /api/loyverse/sync/status — SPEC.md §7. Sanitized sync state:
 * connection status, key version, last successful sync, last webhook
 * received, and recent sync history. Never includes credentials.
 */
import { NextResponse } from "next/server";

import { ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { getLoyverseStatus } from "@/lib/loyverse/status";

export const runtime = "nodejs";

export const GET = withAuth({ module: "SETTINGS" }, async (_req, ctx) => {
  const status = await getLoyverseStatus(ctx.orgId);
  return NextResponse.json(ok({ status }), { status: 200 });
});
