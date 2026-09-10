/**
 * Operator-safe error type for the inventory domain (SPEC.md §19). Carries
 * the HTTP status + envelope code so API routes and the worker can surface
 * failures without leaking internals (no SQL, stack traces, or Prisma error
 * names reach the client or the operator log).
 */
export class InventoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InventoryError";
  }
}
