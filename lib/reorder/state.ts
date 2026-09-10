/**
 * Client-safe reorder action state (issue #17).
 *
 * This module must stay free of server-only imports (db, auth, audit) — the
 * reorder form components import it into the browser bundle.
 */
export interface ReorderActionState {
  ok: boolean;
  message?: string;
}

export const initialReorderState: ReorderActionState = { ok: false };
