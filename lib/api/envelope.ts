/**
 * Consistent API response envelope per SPEC.md §19.
 * Every API response: { ok, error?: { code, message, details }, requestId }.
 *
 * `requestId` is read from the ambient request context (populated by the
 * route wrappers) so callers never pass it; outside a request context a
 * fresh id is generated so the envelope invariant — requestId on EVERY
 * response — holds even in tests and scripts.
 */
import { randomUUID } from "node:crypto";

import { getRequestId } from "@/lib/api/request-context";

function requestId(): string {
  return getRequestId() ?? randomUUID();
}

export function ok<T>(data: T) {
  return { ok: true as const, data, requestId: requestId() };
}

export function apiError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return { ok: false as const, error: { code, message, details }, requestId: requestId() };
}
