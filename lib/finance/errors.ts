/**
 * Operator-safe error type for the finance domain (SPEC.md §19). Carries the
 * HTTP status + envelope code so API routes and server actions can surface
 * failures without leaking internals (no SQL, stack traces, or Prisma error
 * names reach the client).
 */
export class FinanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FinanceError";
  }
}
