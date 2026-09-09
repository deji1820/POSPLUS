/**
 * GET /api/jobs/failed?queue=<name> — dead-letter inspection for authorized
 * admins (SPEC.md §19). Owner-only (SETTINGS module per the §5 matrix).
 * Returns sanitized failed-job records: id, name, attempts, safe reason.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError, ok } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/guard";
import {
  listFailedJobs,
  UnknownQueueError,
} from "@/lib/queue/admin";

export const runtime = "nodejs";

export const GET = withAuth({ module: "SETTINGS" }, async (req: NextRequest) => {
  const queue = req.nextUrl.searchParams.get("queue") ?? "";
  const max = Number(req.nextUrl.searchParams.get("max") ?? 50);
  try {
    const jobs = await listFailedJobs(queue, Number.isFinite(max) ? max : 50);
    return NextResponse.json(ok({ jobs }), { status: 200 });
  } catch (error) {
    if (error instanceof UnknownQueueError) {
      return NextResponse.json(
        apiError("VALIDATION_ERROR", `Unknown queue "${queue}".`, {
          queuesHint: "see SPEC.md §10",
        }),
        { status: 400 },
      );
    }
    throw error;
  }
});
