/**
 * P&L API route (SPEC.md §7 finance API outline, §19 envelope, issue #13):
 *   GET /api/finance/reports/pnl?storeId=&from=&to=&compare=1
 *
 * `withAuth` is mocked to invoke the handler with a fixed owner context
 * (auth itself is covered by tests/guard.test.ts); these tests pin the route
 * wiring: query passing, org scoping, and §19 envelope mapping of FinanceError.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  journalLineFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    journalLine: { findMany: mocks.journalLineFindMany },
  },
}));

vi.mock("@/lib/auth/guard", () => ({
  withAuth:
    (_opts: unknown, handler: (...args: unknown[]) => unknown) =>
    async (req: NextRequest, routeCtx?: { params: Promise<Record<string, string>> }) => {
      const ctx = { userId: "user-1", email: "owner@x.io", orgId: "org-1", role: "OWNER", storeIds: null, warehouseIds: null };
      if (routeCtx?.params !== undefined) {
        return handler(req, await routeCtx.params, ctx);
      }
      return handler(req, ctx);
    },
}));

import { GET } from "@/app/api/finance/reports/pnl/route";

function req(url: string): NextRequest {
  return new Request(url) as never;
}

async function json(res: Response) {
  return res.json() as Promise<{
    ok: boolean;
    data?: { report: Record<string, unknown> };
    error?: { code: string; message: string };
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.journalLineFindMany.mockResolvedValue([]);
});

describe("GET /api/finance/reports/pnl", () => {
  it("returns the report in the §19 envelope, org-scoped", async () => {
    const res = await GET(req("http://x/api/finance/reports/pnl?from=2026-09-01&to=2026-09-30"), {});
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data!.report.consolidated).toBe(true);
    const call = mocks.journalLineFindMany.mock.calls[0][0] as { where: { organizationId: string } };
    expect(call.where.organizationId).toBe("org-1");
  });

  it("passes the store filter and comparison flag through", async () => {
    const res = await GET(
      req("http://x/api/finance/reports/pnl?storeId=store-1&from=2026-09-01&to=2026-09-30&compare=1"),
      {},
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data!.report.storeId).toBe("store-1");
    expect(body.data!.report.consolidated).toBe(false);
    expect(body.data!.report.comparison).not.toBeNull();
    expect(mocks.journalLineFindMany).toHaveBeenCalledTimes(2);
  });

  it("maps FinanceError to its status/code envelope", async () => {
    const res = await GET(req("http://x/api/finance/reports/pnl?from=nope"), {});
    expect(res.status).toBe(400);
    expect((await json(res)).error!.code).toBe("VALIDATION_ERROR");
  });
});
