/**
 * POST /api/loyverse/connect — SPEC.md §7.
 * Input: { apiKey }. Validates the key against Loyverse, encrypts it with the
 * server-side key (SPEC.md §18), stores the envelope, and records a QUEUED
 * INITIAL sync run (worker lands with #6/#7). The stored key is never
 * returned to the browser.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { EncryptionConfigurationError } from "@/lib/encryption";
import { ConnectError, connectLoyverse } from "@/lib/loyverse/connect";

export const runtime = "nodejs";

const connectSchema = z.object({
  apiKey: z.string().min(1).max(200),
});

export const POST = withAuth({ module: "SETTINGS" }, async (req: NextRequest, ctx) => {
  let parsed: z.infer<typeof connectSchema>;
  try {
    parsed = connectSchema.parse(await req.json());
  } catch {
    return NextResponse.json(apiError("VALIDATION_ERROR", "Request body must be { apiKey }."), {
      status: 400,
    });
  }

  try {
    const connection = await connectLoyverse(ctx.orgId, parsed.apiKey, ctx.userId);
    return NextResponse.json(ok({ connection }), { status: 200 });
  } catch (error) {
    if (error instanceof ConnectError) {
      return NextResponse.json(apiError(error.code, error.message), { status: error.status });
    }
    if (error instanceof EncryptionConfigurationError) {
      return NextResponse.json(
        apiError("SERVER_MISCONFIGURED", "Credential storage is not configured."),
        { status: 500 },
      );
    }
    throw error;
  }
});
