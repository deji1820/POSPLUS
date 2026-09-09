import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "@/lib/auth.config";
import { prisma } from "@/lib/db";
import { verifyScryptPassword } from "@/lib/auth/password";
import { checkRateLimit } from "@/lib/auth/rate-limit";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = String(credentials?.email ?? "").toLowerCase().trim();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        // SPEC.md §18: rate-limit authentication endpoints. Per-email window,
        // Redis-shared across replicas (#34); the per-IP limit on the callback
        // route itself lives in app/api/auth/[...nextauth]/route.ts.
        if (!(await checkRateLimit(`login:${email}`))) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.status !== "active") return null;
        if (!verifyScryptPassword(password, user.passwordHash)) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
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
