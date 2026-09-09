import { NextResponse } from "next/server";

import { ok } from "@/lib/api/envelope";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

// apiRoute establishes the request context, so the envelope's requestId is
// set (and log-correlated) without hand-rolling one here.
export const GET = apiRoute(async () =>
  NextResponse.json(ok({ service: "posplus-web", status: "healthy" })),
);
