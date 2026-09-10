/**
 * Settings domain errors (SPEC.md §19). Same operator-safe shape as
 * FinanceError — a stable HTTP status + envelope code + non-leaky message —
 * so the settings server actions can surface failures without exposing
 * internals (no SQL, stack traces, or Prisma error names to the client).
 */
export class SettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Convenience for the common 400 validation case. */
export function validationError(message: string): SettingsError {
  return new SettingsError(400, "VALIDATION_ERROR", message);
}
