/**
 * POST /api/loyverse/sync — SPEC.md §7 (manual / incremental sync request).
 * Authorizes, records a QUEUED sync run, and schedules it on the BullMQ
 * `loyverse-sync` queue (#6). Requires an existing connection (#5).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { enqueueLoyverseSync, QueueUnavailableError } from "@/lib/queue/enqueue";

export const runtime = "nodejs";

const syncSchema = z.object({
  type: z.enum(["MANUAL", "INCREMENTAL"]).optional(),
});

export const POST = withAuth({ module: "SETTINGS" }, async (req: NextRequest, ctx) => {
  let parsed: z.infer<typeof syncSchema>;
  try {
    parsed = syncSchema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json(
      apiError("VALIDATION_ERROR", "Body must be empty or { type?: 'MANUAL' | 'INCREMENTAL' }."),
      { status: 400 },
    );
  }

  const connection = await prisma.loyverseConnection.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true },
  });
  if (!connection) {
    return NextResponse.json(
      apiError("LOYVERSE_NOT_CONNECTED", "Connect a Loyverse API key before syncing."),
      { status: 409 },
    );
  }

  const run = await prisma.syncRun.create({
    data: {
      organizationId: ctx.orgId,
      type: parsed.type ?? "MANUAL",
      status: "QUEUED",
    },
    select: {
      id: true,
      type: true,
      status: true,
      startedAt: true,
    },
  });

  try {
    await enqueueLoyverseSync({ syncRunId: run.id, organizationId: ctx.orgId, type: run.type });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorSummary: "Could not schedule the sync: job queue unavailable.",
        },
      });
      return NextResponse.json(
        apiError("QUEUE_UNAVAILABLE", "The background job queue is unavailable. Try again shortly."),
        { status: 503 },
      );
    }
    throw error;
  }

  return NextResponse.json(ok({ run }), { status: 202 });
});
