import { notImplemented } from "@/lib/api/not-implemented";
import { withAuth } from "@/lib/auth/guard";

export const runtime = "nodejs";

// Reference pattern for the #4 guard: module-gated stub. Implementation
// (#21) replaces the handler body; the authz wrapper stays.
export const GET = withAuth({ module: "WORKFORCE" }, async () => notImplemented());
