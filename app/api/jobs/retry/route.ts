/**
 * POST /api/jobs/retry — move a dead-lettered job back to its queue
 * (SPEC.md §19 retry controls for authorized admins). Owner-only.
 *
 * Body: { queue: string, jobId: string }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import { retryFailedJob, UnknownQueueError } from "@/lib/queue/admin";

export const runtime = "nodejs";

const retrySchema = z.object({
  queue: z.string().min(1).max(100),
  jobId: z.string().min(1).max(200),
});

export const POST = withAuth({ module: "SETTINGS" }, async (req: NextRequest) => {
  let parsed: z.infer<typeof retrySchema>;
  try {
    parsed = retrySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      apiError("VALIDATION_ERROR", "Body must be { queue: string, jobId: string }."),
      { status: 400 },
    );
  }

  try {
    const retried = await retryFailedJob(parsed.queue, parsed.jobId);
    if (!retried) {
      return NextResponse.json(
        apiError("JOB_NOT_FOUND", `No failed job "${parsed.jobId}" on queue "${parsed.queue}".`),
        { status: 404 },
      );
    }
    return NextResponse.json(ok({ retried: true }), { status: 200 });
  } catch (error) {
    if (error instanceof UnknownQueueError) {
      return NextResponse.json(
        apiError("VALIDATION_ERROR", `Unknown queue "${parsed.queue}".`),
        { status: 400 },
      );
    }
    throw error;
  }
});
