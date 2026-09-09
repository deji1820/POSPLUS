/**
 * Minimal structured logger with request correlation (SPEC.md §24:
 * "Include a request/job correlation ID in logs").
 *
 * Every line is a single JSON object carrying the ambient requestId (when
 * called inside an `apiRoute`/`withAuth` wrapper), so log aggregation can
 * pivot from a client-visible envelope requestId to the exact server lines
 * for that request. No free-form interpolation of untrusted data; meta
 * objects should carry sanitized fields only (§24: prefer event IDs and
 * sanitized metadata over raw payloads).
 */
import { getRequestId } from "@/lib/api/request-context";

type Meta = Record<string, unknown>;

function line(level: string, message: string, meta: Meta = {}): void {
  const entry = { level, requestId: getRequestId(), message, ...meta };
  const serialized = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}

export const logger = {
  info: (message: string, meta?: Meta) => line("info", message, meta),
  warn: (message: string, meta?: Meta) => line("warn", message, meta),
  error: (message: string, meta?: Meta) => line("error", message, meta),
};
