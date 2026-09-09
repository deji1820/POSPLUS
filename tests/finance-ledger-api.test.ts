/**
 * Journal API routes (SPEC.md §7 outline, issue #12):
 *   GET  /api/finance/journal-entries         — filtered list
 *   GET  /api/finance/journal-entries/:id     — detail
 *   POST /api/finance/journal-entries/:id/reverse — reversal workflow
 *
 * `withAuth` is mocked to invoke the handler with a fixed owner context
 * (auth itself is covered by tests/guard.test.ts); these tests pin the
 * route wiring: params passing, JSON body parsing, and §19 envelope mapping
 * of FinanceError (status + code, no internals leaked).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  journalEntryFindMany: vi.fn(),
  journalEntryFindFirst: vi.fn(),
  journalEntryCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    journalEntry: {
      findMany: mocks.journalEntryFindMany,
      findFirst: mocks.journalEntryFindFirst,
      create: mocks.journalEntryCreate,
    },
    auditLog: { create: mocks.auditLogCreate },
    $transaction: mocks.$transaction,
  },
}));

// Mirror the real withAuth delegation contract: static routes get
// (req, ctx); dynamic routes get (req, params, ctx).
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

import { GET as LIST } from "@/app/api/finance/journal-entries/route";
import { GET as DETAIL } from "@/app/api/finance/journal-entries/[id]/route";
import { POST as REVERSE } from "@/app/api/finance/journal-entries/[id]/reverse/route";

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as never;
}

async function json(res: Response) {
  return res.json() as Promise<{
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      journalEntry: { create: mocks.journalEntryCreate },
      auditLog: { create: mocks.auditLogCreate },
    }),
  );
});

describe("GET /api/finance/journal-entries", () => {
  it("returns the filtered list in the §19 envelope", async () => {
    mocks.journalEntryFindMany.mockResolvedValue([]);
    const res = await LIST(req("http://x/api/finance/journal-entries?source=receipt&storeId=s1"), {});
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(mocks.journalEntryFindMany).toHaveBeenCalled();
  });

  it("maps FinanceError to its status/code envelope", async () => {
    const res = await LIST(req("http://x/api/finance/journal-entries?source=nope"), {});
    expect(res.status).toBe(400);
    expect((await json(res)).error!.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/finance/journal-entries/:id", () => {
  it("passes the route param and returns the detail", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({
      id: "je-1",
      entryNumber: null,
      description: "Sale",
      status: "POSTED",
      postedAt: new Date("2026-09-01T00:00:00Z"),
      store: null,
      fiscalPeriod: null,
      reversalOfId: null,
      reversedBy: null,
      sourceLink: null,
      lines: [
        { id: "l1", accountId: "a1", debit: "1.00", credit: "0.00", memo: null, account: { code: "1000", name: "Cash" } },
        { id: "l2", accountId: "a2", debit: "0.00", credit: "1.00", memo: null, account: { code: "4000", name: "Sales" } },
      ],
    });
    const res = await DETAIL(req("http://x/api/finance/journal-entries/je-1"), {
      params: Promise.resolve({ id: "je-1" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(mocks.journalEntryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "je-1", organizationId: "org-1" } }),
    );
  });

  it("404s in the envelope when the entry does not exist", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue(null);
    const res = await DETAIL(req("http://x/api/finance/journal-entries/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error!.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/finance/journal-entries/:id/reverse", () => {
  const ORIGINAL = {
    id: "je-1",
    entryNumber: null,
    description: "Sale",
    status: "POSTED",
    storeId: null,
    fiscalPeriodId: null,
    reversalOfId: null,
    reversedBy: null,
    lines: [
      { accountId: "a1", debit: "1.00", credit: "0.00", memo: null },
      { accountId: "a2", debit: "0.00", credit: "1.00", memo: null },
    ],
  };

  beforeEach(() => {
    mocks.journalEntryFindFirst.mockResolvedValue(ORIGINAL);
    mocks.journalEntryCreate.mockResolvedValue({ id: "je-1-R" });
  });

  it("creates the reversal and returns 201 with the new entry id", async () => {
    const res = await REVERSE(
      req("http://x/api/finance/journal-entries/je-1/reverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "duplicate" }),
      }),
      { params: Promise.resolve({ id: "je-1" }) },
    );
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({
      ok: true,
      data: { reversalEntryId: "je-1-R" },
      requestId: expect.any(String),
    });
    expect(mocks.journalEntryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reversalOfId: "je-1" }),
    });
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await REVERSE(
      req("http://x/api/finance/journal-entries/je-1/reverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{oops",
      }),
      { params: Promise.resolve({ id: "je-1" }) },
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error!.code).toBe("VALIDATION_ERROR");
  });

  it("maps reversal guard failures to their envelopes", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({ ...ORIGINAL, reversedBy: { id: "je-1-R" } });
    const res = await REVERSE(
      req("http://x/api/finance/journal-entries/je-1/reverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "again" }),
      }),
      { params: Promise.resolve({ id: "je-1" }) },
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error!.code).toBe("ALREADY_REVERSED");
  });
});
