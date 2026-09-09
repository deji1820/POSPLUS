/**
 * Catalog of stable API error codes (SPEC.md §19: "Catalog of typed error
 * codes"). Codes are grouped by domain; the envelope contract is that a
 * code is a stable, machine-checkable string whose meaning never changes —
 * clients switch on codes, not messages. New domains add their codes here
 * when they land (e.g. PURCHASE_ORDER_INVALID_STATE with the purchasing
 * API), keeping the catalog the single source of truth.
 */
export const ERROR_CODES = {
  /** Cross-cutting: any route may return these. */
  COMMON: {
    VALIDATION_ERROR: "VALIDATION_ERROR",
    NOT_FOUND: "NOT_FOUND",
    FORBIDDEN: "FORBIDDEN",
    UNAUTHORIZED: "UNAUTHORIZED",
    RATE_LIMITED: "RATE_LIMITED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
    SERVER_MISCONFIGURED: "SERVER_MISCONFIGURED",
    QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",
  },
  /** Loyverse integration (webhooks, sync, connection state). */
  LOYVERSE: {
    INVALID_WEBHOOK_SIGNATURE: "INVALID_WEBHOOK_SIGNATURE",
    INVALID_WEBHOOK_PAYLOAD: "INVALID_WEBHOOK_PAYLOAD",
    WEBHOOK_NOT_CONFIGURED: "WEBHOOK_NOT_CONFIGURED",
    LOYVERSE_NOT_CONNECTED: "LOYVERSE_NOT_CONNECTED",
  },
  /** Background jobs. */
  JOBS: {
    JOB_NOT_FOUND: "JOB_NOT_FOUND",
  },
  /** Finance / ledger (issued via FinanceError). */
  FINANCE: {
    ACCOUNT_CODE_EXISTS: "ACCOUNT_CODE_EXISTS",
    ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
    INVALID_SOURCE: "INVALID_SOURCE",
    ENTRY_NOT_POSTED: "ENTRY_NOT_POSTED",
    ALREADY_REVERSED: "ALREADY_REVERSED",
    IS_REVERSAL: "IS_REVERSAL",
    UNBALANCED_ENTRY: "UNBALANCED_ENTRY",
  },
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES][keyof (typeof ERROR_CODES)[keyof typeof ERROR_CODES]];
