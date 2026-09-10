/**
 * Operator-safe error type for the documents domain (SPEC.md §19, issue #32).
 * Same pattern as FinanceError: HTTP status + stable envelope code; no
 * internals (SDK errors, stack traces) ever reach the client.
 */
export class DocumentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentsError";
  }
}
