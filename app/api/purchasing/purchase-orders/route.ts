import { notImplemented } from "@/lib/api/not-implemented";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";

// Reference pattern for the #4 guard: module-gated stub. Implementation
// (#18) replaces the handler body; the authz wrapper stays.
export const GET = withAuth({ module: "PURCHASING" }, async () => notImplemented());
export const POST = withAuth({ module: "PURCHASING" }, async () => notImplemented());
