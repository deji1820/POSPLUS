/**
 * Route wrapper for API handlers that do not go through `withAuth`
 * (SPEC.md §19): establishes the request context (requestId), and converts
 * ANY thrown exception into the stable error envelope — no stack traces,
 * SQL, or internals reach the client, and the requestId on the response
 * matches the requestId on the error log line (§24 correlation).
 *
 * Domain errors (FinanceError, webhook signature failures, zod
 * VALIDATION_ERROR, …) are already mapped to envelopes by the handlers
 * themselves; this is the last-resort net for the unexpected.
 */
import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/envelope";
import { resolveRequestId, runWithRequestContext } from "@/lib/api/request-context";
import { logger } from "@/lib/logger";

/** Log the failure server-side (with requestId) and return the §19 envelope. */
export function unexpectedErrorResponse(error: unknown): NextResponse {
  // Internal detail stays in the log; the client gets a stable code only.
  logger.error("unhandled route error", {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json(
    apiError("INTERNAL_ERROR", "An unexpected error occurred."),
    { status: 500 },
  );
}

type RouteArgs = unknown[];

/**
 * Wrap a plain route handler: `(req, ...args) => Response`. Static routes
 * pass `(req)`; dynamic routes pass `(req, params)` — args flow through
 * untouched. `Req` is inferred from the handler so NextRequest-requiring
 * handlers (e.g. the webhook route) type-check while plain `Request` mocks
 * in tests stay legal.
 */
export function apiRoute<Req extends Request, A extends RouteArgs, R extends Response>(
  handler: (req: Req, ...args: A) => Promise<R> | R,
) {
  return async (req: Req, ...args: A): Promise<R | NextResponse> => {
    const requestId = resolveRequestId(req);
    return runWithRequestContext(requestId, async () => {
      try {
        return await handler(req, ...args);
      } catch (error) {
        return unexpectedErrorResponse(error);
      }
    });
  };
}
