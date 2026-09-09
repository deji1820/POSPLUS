/**
 * Route wrappers (SPEC.md §19 error envelope + §24 request correlation,
 * issue #14).
 *
 * Acceptance: "a thrown exception in any route returns the envelope with a
 * stable error code and a requestId that matches the server log line."
 *
 * `apiRoute` covers plain handlers (webhook, health, stubs); `withAuth`
 * covers guarded handlers. Both establish the AsyncLocalStorage request
 * context so envelope helpers attach the id without call-site changes, and
 * both convert unexpected throws into INTERNAL_ERROR — internal details
 * (stack, SQL, provider errors) stay in the server log only.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  logSpy: vi.fn(),
}));

vi.mock("@/lib/auth/session-context", () => ({
  AuthContextError: class AuthContextError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "AuthContextError";
    }
  },
  getSessionContext: mocks.getSessionContext,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const OWNER_CTX = {
  userId: "user-1",
  email: "owner@x.io",
  orgId: "org-1",
  role: "OWNER",
  storeIds: null,
  warehouseIds: null,
};

async function body(res: Response) {
  return res.json() as Promise<{
    ok: boolean;
    requestId?: string;
    error?: { code: string; message: string };
  }>;
}

/** Every logged error line, parsed. */
function loggedErrors(): Array<{ requestId?: string; message?: string }> {
  return mocks.logSpy.mock.calls.map(
    (call) => JSON.parse(call[0] as string) as { requestId?: string; message?: string },
  );
}

describe("apiRoute", () => {
  it("establishes the request context so envelopes carry the requestId", async () => {
    const { apiRoute } = await import("@/lib/api/handler");
    const { ok } = await import("@/lib/api/envelope");
    const GET = apiRoute(async () => NextResponse.json(ok({ ping: true })));
    const res = await GET(new Request("http://x/api/health"));
    const parsed = await body(res);
    expect(res.status).toBe(200);
    expect(parsed.ok).toBe(true);
    expect(parsed.requestId).toEqual(expect.any(String));
  });

  it("honors a valid inbound x-request-id header", async () => {
    const { apiRoute } = await import("@/lib/api/handler");
    const { ok } = await import("@/lib/api/envelope");
    const GET = apiRoute(async () => NextResponse.json(ok({})));
    const res = await GET(
      new Request("http://x/api/health", { headers: { "x-request-id": "edge-123-abc" } }),
    );
    expect((await body(res)).requestId).toBe("edge-123-abc");
  });

  it("rejects a malformed inbound id and generates a safe one", async () => {
    const { apiRoute } = await import("@/lib/api/handler");
    const { ok } = await import("@/lib/api/envelope");
    const GET = apiRoute(async () => NextResponse.json(ok({})));
    const res = await GET(
      new Request("http://x/api/health", { headers: { "x-request-id": "bad id injected" } }),
    );
    const parsed = await body(res);
    expect(parsed.requestId).toEqual(expect.any(String));
    expect(parsed.requestId).not.toBe("bad id injected");
  });

  it("converts a thrown exception into a 500 INTERNAL_ERROR envelope with matching log requestId", async () => {
    const { apiRoute } = await import("@/lib/api/handler");
    const GET = apiRoute(async () => {
      throw new Error("select * from secrets -- boom");
    });
    const res = await GET(new Request("http://x/api/anything"));
    expect(res.status).toBe(500);
    const parsed = await body(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.error!.code).toBe("INTERNAL_ERROR");
    // Stable, non-leaking message — the SQL-looking throw detail must NOT
    // reach the client (§19).
    expect(parsed.error!.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(parsed)).not.toContain("secrets");

    const log = loggedErrors().find((entry) => entry.message === "unhandled route error");
    expect(log).toBeDefined();
    expect(log!.requestId).toBe(parsed.requestId);
  });
});

describe("withAuth request context (issue #14)", () => {
  it("denials carry a requestId that matches the denial log context", async () => {
    mocks.getSessionContext.mockResolvedValue({ ...OWNER_CTX, role: "STORE_MANAGER" });
    const { withAuth } = await import("@/lib/auth/guard");
    const GET = withAuth({ module: "FINANCE" }, async () => NextResponse.json({ never: true }));
    const res = await GET(
      new Request("http://x/api/finance/accounts", {
        headers: { "x-request-id": "denial-42" },
      }) as never,
    );
    const parsed = await body(res);
    expect(res.status).toBe(403);
    expect(parsed.error!.code).toBe("FORBIDDEN");
    expect(parsed.requestId).toBe("denial-42");
  });

  it("a thrown exception in a guarded handler returns the envelope with a stable code + log-matching requestId", async () => {
    mocks.getSessionContext.mockResolvedValue(OWNER_CTX);
    const { withAuth } = await import("@/lib/auth/guard");
    const GET = withAuth({ module: "FINANCE" }, async () => {
      throw new Error("prisma connection reset by peer");
    });
    const res = await GET(new Request("http://x/api/finance/accounts") as never);
    const parsed = await body(res);
    expect(res.status).toBe(500);
    expect(parsed.ok).toBe(false);
    expect(parsed.error!.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(parsed)).not.toContain("prisma");

    const log = loggedErrors().find((entry) => entry.message === "unhandled route error");
    expect(log).toBeDefined();
    expect(log!.requestId).toBe(parsed.requestId);
  });

  it("successful guarded responses carry the request context id", async () => {
    mocks.getSessionContext.mockResolvedValue(OWNER_CTX);
    const { withAuth } = await import("@/lib/auth/guard");
    const { ok } = await import("@/lib/api/envelope");
    const GET = withAuth({ module: "FINANCE" }, async () => NextResponse.json(ok({ fine: 1 })));
    const res = await GET(
      new Request("http://x/api/finance/accounts", { headers: { "x-request-id": "ok-7" } }) as never,
    );
    expect((await body(res)).requestId).toBe("ok-7");
  });
});
