/**
 * Inventory API routes (issue #16, SPEC.md §6):
 *   GET /api/supply-chain/inventory            — filtered balances
 *   GET /api/supply-chain/inventory/movements  — cursor-paginated ledger
 *
 * `withAuth` is mocked to invoke the handler with a fixed store-scoped
 * context (auth itself is covered by tests/guard.test.ts); these tests pin
 * the route wiring: scope threading from the session context, query passing,
 * and §19 envelope mapping of InventoryError (status + code only).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inventoryBalanceFindMany: vi.fn(),
  inventoryMovementFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    inventoryBalance: { findMany: mocks.inventoryBalanceFindMany },
    inventoryMovement: { findMany: mocks.inventoryMovementFindMany },
  },
}));

// Mirror the real withAuth delegation contract for static routes: (req, ctx).
vi.mock("@/lib/auth/guard", () => ({
  withAuth:
    (_opts: unknown, handler: (...args: unknown[]) => unknown) =>
    async (req: NextRequest) => {
      const ctx = {
        userId: "user-1",
        email: "manager@x.io",
        orgId: "org-1",
        role: "STORE_MANAGER",
        storeIds: ["store-1"],
        warehouseIds: null,
      };
      return handler(req, ctx);
    },
}));

import { GET as BALANCES } from "@/app/api/supply-chain/inventory/route";
import { GET as MOVEMENTS } from "@/app/api/supply-chain/inventory/movements/route";

function req(url: string): NextRequest {
  return new Request(url) as never;
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
});

describe("GET /api/supply-chain/inventory", () => {
  it("returns balances scoped to the caller's store access", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);

    const res = await BALANCES(req("http://localhost/api/supply-chain/inventory?lowStock=1"));
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.inventoryBalanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { organizationId: "org-1" },
            { warehouse: { storeId: { in: ["store-1"] } } },
          ]),
        }),
      }),
    );
  });

  it("maps InventoryError to the §19 envelope", async () => {
    mocks.inventoryBalanceFindMany.mockResolvedValue([]);

    const res = await BALANCES(req("http://localhost/api/supply-chain/inventory"));
    const okBody = await json(res);
    expect(res.status).toBe(200);
    expect(okBody.ok).toBe(true);

    // Movements validate the type enum — an unknown type is a 400 envelope.
    const bad = await MOVEMENTS(
      req("http://localhost/api/supply-chain/inventory/movements?type=TELEPORT"),
    );
    const badBody = await json(bad);
    expect(bad.status).toBe(400);
    expect(badBody.ok).toBe(false);
    expect(badBody.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/supply-chain/inventory/movements", () => {
  it("returns a paginated movement page", async () => {
    mocks.inventoryMovementFindMany.mockResolvedValue([
      {
        id: "mov-1",
        createdAt: new Date("2026-09-10T12:00:00Z"),
        quantityDelta: "-2.000",
        type: "SALE",
        referenceType: "Receipt",
        referenceId: "rec-1",
        variant: { id: "v-1", name: "Beans 1kg", item: { name: "Beans" } },
        warehouse: { id: "wh-1", name: "WH-MAIN", store: { name: "Downtown" } },
      },
    ]);

    const res = await MOVEMENTS(
      req("http://localhost/api/supply-chain/inventory/movements?type=SALE&limit=10"),
    );
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.inventoryMovementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
  });
});
