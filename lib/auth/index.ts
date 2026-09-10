import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "@/lib/auth.config";
import { AUDIT_ACTIONS, writeUserAuthAudit } from "@/lib/audit/writer";
import { prisma } from "@/lib/db";
import { verifyScryptPassword } from "@/lib/auth/password";
import { checkRateLimit } from "@/lib/auth/rate-limit";

/** Credentials authorize, exported for unit tests (§17 auth audit wiring). */
export const credentialsAuthorize = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  credentials: any,
): Promise<{ id: string; email: string; name: string | null } | null> => {
    const email = String(credentials?.email ?? "").toLowerCase().trim();
    const password = String(credentials?.password ?? "");
    if (!email || !password) return null;

    // SPEC.md §18: rate-limit authentication endpoints. Per-email window;
    // production Redis backing lands with #34.
    if (!checkRateLimit(`login:${email}`)) return null;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== "active") return null;
    if (!verifyScryptPassword(password, user.passwordHash)) {
      // §17: record the failed attempt against the known user (the email
      // was valid even though the password was not). Unknown emails have
      // no org to audit against — the rate limit above is their guard.
      await writeUserAuthAudit(user.id, AUDIT_ACTIONS.AUTH.LOGIN_FAILED, {
        email: user.email,
      });
      return null;
    }

    return { id: user.id, email: user.email, name: user.name };
  };

/** Auth lifecycle audit events (§17), exported for unit tests. */
export const authEvents: NonNullable<NextAuthConfig["events"]> = {
  // Events are fire-and-forget in Auth.js; the writer itself never throws,
  // so a failed audit never blocks auth.
  async signIn({ user }) {
    if (user?.id) {
      await writeUserAuthAudit(user.id, AUDIT_ACTIONS.AUTH.LOGIN, {
        email: user.email ?? null,
      });
    }
  },
  async signOut(event) {
    const token = "token" in event ? event.token : null;
    const userId = token?.sub ?? token?.id;
    if (typeof userId === "string" && userId) {
      await writeUserAuthAudit(userId, AUDIT_ACTIONS.AUTH.LOGOUT);
    }
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: credentialsAuthorize,
    }),
  ],
  events: authEvents,
  callbacks: {
    jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
