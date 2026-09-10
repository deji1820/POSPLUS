import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Security headers (SPEC.md §18) on every response — pages and APIs alike:
 *   nosniff           stops MIME-sniffing confusion on uploads/downloads
 *   DENY frame        clickjacking protection (the app never frames itself)
 *   Referrer-Policy   leaks origin-only cross-site, full URL same-site
 *   Permissions-Policy disables camera/mic/geolocation we never use
 *   CSP               self-contained app: no external scripts/styles/fonts;
 *                     'unsafe-inline' for script/style is the standard Next.js
 *                     requirement (inline hydration payload + styled-jsx);
 *                     'unsafe-eval' only in dev (HMR)
 *   HSTS (prod only)  browsers upgrade to HTTPS for two years incl. subdomains
 */
function contentSecurityPolicy(): string {
  const scriptSrc = isProd
    ? "'self' 'unsafe-inline'"
    : "'self' 'unsafe-inline' 'unsafe-eval'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
