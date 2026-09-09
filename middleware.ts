import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/lib/auth.config";

const PUBLIC_PATHS = ["/login", "/signup"];

// Use the edge-safe config subset: the Credentials provider pulls in
// node:crypto (scrypt), which the Edge Runtime does not support. Session
// verification itself is edge-safe.
export default NextAuth(authConfig).auth((request) => {
  const { nextUrl } = request;
  const isLoggedIn = Boolean(request.auth);
  const isPublic = PUBLIC_PATHS.includes(nextUrl.pathname);

  if (!isLoggedIn && !isPublic) {
    return NextResponse.redirect(new URL("/login", nextUrl));
  }
  if (isLoggedIn && isPublic) {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }
});

// Apply to everything except API routes (which authorize per-route), auth
// callbacks, and static assets.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
