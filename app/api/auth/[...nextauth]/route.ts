/**
 * Auth.js catch-all (SPEC.md §18). Session/CSRF GETs stay un-limited (the UI
 * polls /api/auth/session); mutating POSTs (credentials callback, sign-out)
 * are rate-limited per source IP — the per-email limit inside `authorize`
 * (lib/auth/index.ts) catches credential-stuffing spread across IPs, this
 * one catches one IP spraying many accounts. Redis-shared (#34), §19
 * envelope on denial.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/envelope";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { handlers } from "@/lib/auth";

export const runtime = "nodejs";

const POST_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export const GET = handlers.GET;

export const POST = async (req: NextRequest): Promise<Response> => {
  if (!(await checkRateLimit(`auth-post:${clientIp(req)}`, POST_LIMIT, POST_WINDOW_MS))) {
    return NextResponse.json(
      apiError("RATE_LIMITED", "Too many authentication attempts. Wait a minute and retry."),
      { status: 429 },
    );
  }
  return handlers.POST(req);
};
