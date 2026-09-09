/**
 * Job error taxonomy driving the §19 retry policy:
 *
 * - Throw `TransientJobError` (or any plain Error) from a processor for a
 *   retryable condition (provider down, network blip, DB unreachable).
 *   BullMQ retries with exponential backoff; the final failure lands in the
 *   queue's failed set (dead-letter) with the safe message preserved.
 * - Throw bullmq's `UnrecoverableError` for permanent conditions (bad data,
 *   missing records, not-implemented job types) — no retry, straight to the
 *   dead-letter path.
 *
 * Messages thrown from processors must be operator-safe: no stack traces,
 * secrets, SQL, or provider internals (SPEC.md §19/§24).
 */
import { UnrecoverableError } from "bullmq";

export { UnrecoverableError };

export class TransientJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientJobError";
  }
}

/**
 * Reduce an unknown caught error to an operator-safe message. Only errors we
 * raise ourselves (TransientJobError / UnrecoverableError) keep their message
 * — anything else (driver errors, SQL, network stacks) is reported as a
 * generic failure so internals never reach logs shown to operators or the
 * dead-letter record (SPEC.md §19/§24). Engine authors must wrap expected
 * transient conditions in TransientJobError with a safe message.
 */
export function safeJobErrorMessage(error: unknown): string {
  if (error instanceof TransientJobError) return error.message;
  if (error instanceof UnrecoverableError) return error.message;
  return "Unexpected worker error. Retry the job or contact support.";
}

export function isTransient(error: unknown): boolean {
  return !(error instanceof UnrecoverableError);
}
