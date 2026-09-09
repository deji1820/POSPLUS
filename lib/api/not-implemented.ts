import { NextResponse } from "next/server";
import { apiError } from "./envelope";

/**
 * Placeholder handler for routes that are scaffolded but not yet implemented.
 * Returns the SPEC.md §19 error envelope with HTTP 501.
 */
export async function notImplemented() {
  return NextResponse.json(apiError("NOT_IMPLEMENTED", "This endpoint is not implemented yet."), {
    status: 501,
  });
}
