/**
 * Client-safe settings action state (SPEC.md §6 Settings).
 *
 * This module must stay free of server-only imports (db, auth, audit) — the
 * settings form components import it into the browser bundle.
 */
export interface SettingsActionState {
  ok: boolean;
  message?: string;
}

export const initialSettingsState: SettingsActionState = { ok: false };
