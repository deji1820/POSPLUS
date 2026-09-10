/**
 * Reorder domain errors (issue #17). Converted to a user-safe action state by
 * the server actions; anything else is rethrown so it lands in server logs.
 */
export class ReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorderError";
  }
}

/** Suggestion missing, belongs to another org, or already handled. */
export class ReorderSuggestionNotFoundError extends ReorderError {
  constructor() {
    super("Suggestion not found or already handled.");
    this.name = "ReorderSuggestionNotFoundError";
  }
}

/** Supplier missing, belongs to another org, or inactive. */
export class ReorderSupplierNotFoundError extends ReorderError {
  constructor() {
    super("Supplier not found or inactive.");
    this.name = "ReorderSupplierNotFoundError";
  }
}
