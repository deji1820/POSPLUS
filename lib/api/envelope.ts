/**
 * Consistent API response envelope per SPEC.md §19.
 * Every API response: { ok, error?: { code, message, details }, requestId }.
 */
export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function apiError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return { ok: false as const, error: { code, message, details } };
}
