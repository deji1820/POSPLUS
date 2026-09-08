import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe subset of the Auth.js config (SPEC.md §18).
 *
 * Middleware runs in the Edge Runtime, where `node:crypto` (scrypt password
 * verification) is unavailable. Only session/pages settings live here — the
 * Credentials provider and its password hashing stay in `lib/auth/index.ts`,
 * which is only imported by Node.js runtimes (route handlers, server actions).
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Filled in by lib/auth/index.ts (Node runtime only) — must stay empty here
  // so no Credentials/scrypt code reaches the Edge middleware bundle.
  providers: [],
} satisfies NextAuthConfig;
