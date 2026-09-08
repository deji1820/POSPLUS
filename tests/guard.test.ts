import type { Role } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionContext } from "@/lib/auth/session-context";
import { canAccessStore, canAccessWarehouse, requireModule, withAuth } from "@/lib/auth/guard";
import { getSessionContext } from "@/lib/auth/session-context";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membershipFindMany: vi.fn(),
  storeAccessFindMany: vi.fn(),
  warehouseAccessFindMany: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  prisma: {
    organizationMembership: { findMany: mocks.membershipFindMany },
    userStoreAccess: { findMany: mocks.storeAccessFindMany },
    userWarehouseAccess: { findMany: mocks.warehouseAccessFindMany },
  },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => ({ get: mocks.cookieGet })) }));

const USER_ID = "user-1";

function membership(orgId: string, role: Role, createdAt = new Date("2026-01-01T00:00:00Z")) {
  return {
    id: `m-${orgId}`,
    organizationId: orgId,
    userId: USER_ID,
    role,
    status: "ACTIVE" as const,
    createdAt,
    updatedAt: createdAt,
  };
}

function signIn(role: Role = "OWNER", orgId = "org-1") {
  mocks.auth.mockResolvedValue({ user: { id: USER_ID, email: "a@posplus.dev" } });
  mocks.membershipFindMany.mockResolvedValue([membership(orgId, role)]);
  mocks.storeAccessFindMany.mockResolvedValue([]);
  mocks.warehouseAccessFindMany.mockResolvedValue([]);
  mocks.cookieGet.mockReturnValue(undefined);
}

async function readError(res: Response) {
  const body = (await res.json()) as { error: { code: string } };
  return { status: res.status, code: body.error.code };
}

const okHandler = vi.fn(
  async (_req: NextRequest, _ctx: SessionContext) => new Response("ok", { status: 200 }),
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSessionContext (SPEC.md §5)", () => {
  it("throws AUTH_REQUIRED (401) without a session", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(getSessionContext()).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
  });

  it("throws ORG_MEMBERSHIP_REQUIRED (403) with no active membership", async () => {
    mocks.auth.mockResolvedValue({ user: { id: USER_ID, email: "a@posplus.dev" } });
    mocks.membershipFindMany.mockResolvedValue([]);
    await expect(getSessionContext()).rejects.toMatchObject({
      status: 403,
      code: "ORG_MEMBERSHIP_REQUIRED",
    });
  });

  it("resolves org, role, and unrestricted scope for an OWNER", async () => {
    signIn("OWNER");
    const ctx = await getSessionContext();
    expect(ctx).toMatchObject({ orgId: "org-1", role: "OWNER", storeIds: null, warehouseIds: null });
    // Unscoped roles never even query the access tables.
    expect(mocks.storeAccessFindMany).not.toHaveBeenCalled();
    expect(mocks.warehouseAccessFindMany).not.toHaveBeenCalled();
  });

  it("narrows a STORE_MANAGER to their UserStoreAccess rows", async () => {
    signIn("STORE_MANAGER");
    mocks.storeAccessFindMany.mockResolvedValue([{ storeId: "s1" }]);
    const ctx = await getSessionContext();
    expect(ctx.storeIds).toEqual(["s1"]);
  });

  it("treats a scoped role with no access rows as unrestricted within the org", async () => {
    signIn("STORE_MANAGER"); // no store rows
    const ctx = await getSessionContext();
    expect(ctx.storeIds).toBeNull();
  });

  it("honors the active-org cookie when it matches a membership", async () => {
    signIn("OWNER");
    mocks.membershipFindMany.mockResolvedValue([
      membership("org-a", "OWNER", new Date("2026-01-01T00:00:00Z")),
      membership("org-b", "ACCOUNTANT", new Date("2026-02-01T00:00:00Z")),
    ]);
    mocks.cookieGet.mockReturnValue({ value: "org-b" });
    const ctx = await getSessionContext();
    expect(ctx).toMatchObject({ orgId: "org-b", role: "ACCOUNTANT" });
  });

  it("ignores the active-org cookie when it is not a membership", async () => {
    signIn("OWNER");
    mocks.membershipFindMany.mockResolvedValue([
      membership("org-a", "OWNER", new Date("2026-01-01T00:00:00Z")),
      membership("org-b", "ACCOUNTANT", new Date("2026-02-01T00:00:00Z")),
    ]);
    mocks.cookieGet.mockReturnValue({ value: "org-evil" });
    const ctx = await getSessionContext();
    expect(ctx.orgId).toBe("org-a");
  });
});

describe("withAuth guard (SPEC.md §5/§18/§19)", () => {
  const req = () => new NextRequest("http://localhost/api/test");

  it("returns 401 AUTH_REQUIRED when anonymous", async () => {
    mocks.auth.mockResolvedValue(null);
    const GET = withAuth({ module: "FINANCE" }, okHandler);
    expect(await readError(await GET(req()))).toEqual({ status: 401, code: "AUTH_REQUIRED" });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN when the role lacks the module", async () => {
    signIn("WAREHOUSE_STAFF");
    const GET = withAuth({ module: "FINANCE" }, okHandler);
    expect(await readError(await GET(req()))).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("runs the handler when an OWNER passes the FINANCE gate", async () => {
    signIn("OWNER");
    const GET = withAuth({ module: "FINANCE" }, okHandler);
    expect((await GET(req())).status).toBe(200);
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it("passes the session context to the handler (org scoping hook)", async () => {
    signIn("ACCOUNTANT", "org-42");
    const GET = withAuth({ module: "FINANCE" }, okHandler);
    await GET(req());
    expect(okHandler.mock.calls[0][1]).toMatchObject({ orgId: "org-42", role: "ACCOUNTANT" });
  });

  it("rejects a store outside the caller's scope — cross-org access denied", async () => {
    signIn("STORE_MANAGER");
    mocks.storeAccessFindMany.mockResolvedValue([{ storeId: "s-org1" }]);
    const handler = okHandler as unknown as (
      r: NextRequest,
      p: string,
      c: SessionContext,
    ) => Promise<Response>;
    const GET = withAuth({ module: "INVENTORY", storeId: (p: string) => p }, handler);
    expect(await readError(await GET(req(), { params: Promise.resolve("s-org2") }))).toEqual({
      status: 403,
      code: "STORE_SCOPE_DENIED",
    });
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("allows a store inside the caller's scope", async () => {
    signIn("STORE_MANAGER");
    mocks.storeAccessFindMany.mockResolvedValue([{ storeId: "s-org1" }]);
    const handler = okHandler as unknown as (
      r: NextRequest,
      p: string,
      c: SessionContext,
    ) => Promise<Response>;
    const GET = withAuth({ module: "INVENTORY", storeId: (p: string) => p }, handler);
    expect((await GET(req(), { params: Promise.resolve("s-org1") })).status).toBe(200);
  });

  it("rejects a warehouse outside the caller's scope", async () => {
    signIn("WAREHOUSE_STAFF");
    mocks.warehouseAccessFindMany.mockResolvedValue([{ warehouseId: "w1" }]);
    const handler = okHandler as unknown as (
      r: NextRequest,
      p: string,
      c: SessionContext,
    ) => Promise<Response>;
    const GET = withAuth({ module: "TRANSFERS", warehouseId: (p: string) => p }, handler);
    expect(await readError(await GET(req(), { params: Promise.resolve("w2") }))).toEqual({
      status: 403,
      code: "WAREHOUSE_SCOPE_DENIED",
    });
  });

  it("passes awaited dynamic params through to the handler", async () => {
    signIn("OWNER");
    const handler = vi.fn(async (_req: NextRequest, id: string, _ctx: SessionContext) =>
      Response.json({ id }),
    );
    const GET = withAuth({ module: "PRODUCTION", storeId: () => undefined }, handler);
    const res = await GET(req(), { params: Promise.resolve("po-9") });
    expect(((await res.json()) as { id: string }).id).toBe("po-9");
    expect(handler.mock.calls[0][1]).toBe("po-9");
  });
});

describe("requireModule (server actions)", () => {
  it("returns the context when permitted", async () => {
    signIn("HR_ADMIN");
    const ctx = await requireModule("PAYROLL");
    expect(ctx.role).toBe("HR_ADMIN");
  });

  it("throws FORBIDDEN when denied", async () => {
    signIn("ACCOUNTANT");
    await expect(requireModule("PAYROLL")).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  it("throws AUTH_REQUIRED when anonymous", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(requireModule("PAYROLL")).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
  });
});

describe("scope helpers", () => {
  it("canAccessStore / canAccessWarehouse honor null-as-unrestricted", async () => {
    signIn("OWNER");
    const ctx = await getSessionContext();
    expect(canAccessStore(ctx, "any-store")).toBe(true);
    expect(canAccessWarehouse(ctx, "any-warehouse")).toBe(true);
  });
});
