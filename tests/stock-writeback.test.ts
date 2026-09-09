/**
 * Outbound stock write-back (issue #16, SPEC.md §8): Loyverse stock is
 * ABSOLUTE (`stock_after`), each attempt is recorded with sanitized
 * request/response metadata, and the API key is decrypted in memory only —
 * it appears in the outbound Authorization header but NEVER in the
 * StockWritebackRequest row (§24 no-secrets rule, asserted here).
 *
 * Error taxonomy: network/429/5xx → TransientJobError (BullMQ retry);
 * 401/403 → UnrecoverableError (reconnect); other 4xx → UnrecoverableError.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";
import {
  enqueueStockWriteback,
  performStockWriteback,
} from "@/lib/loyverse/stock-writeback";

const SECRET_KEY = "loyverse-secret-key-must-never-persist";

const mocks = vi.hoisted(() => ({
  stockWritebackRequestFindFirst: vi.fn(),
  stockWritebackRequestCreate: vi.fn(),
  stockWritebackRequestUpdate: vi.fn(),
  variantFindFirst: vi.fn(),
  storeFindFirst: vi.fn(),
  loyverseConnectionFindUnique: vi.fn(),
  decryptSecret: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    stockWritebackRequest: {
      findFirst: mocks.stockWritebackRequestFindFirst,
      create: mocks.stockWritebackRequestCreate,
      update: mocks.stockWritebackRequestUpdate,
    },
    variant: { findFirst: mocks.variantFindFirst },
    store: { findFirst: mocks.storeFindFirst },
    loyverseConnection: { findUnique: mocks.loyverseConnectionFindUnique },
  },
}));

vi.mock("@/lib/encryption", () => ({
  decryptSecret: mocks.decryptSecret,
}));

vi.mock("@/lib/queue/queues", () => ({
  getQueue: () => ({ add: mocks.queueAdd }),
  JOB_QUEUES: { "write-back-stock": "inventory" },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptSecret.mockReturnValue({ plaintext: SECRET_KEY, keyVersion: "v1" });
  mocks.loyverseConnectionFindUnique.mockResolvedValue({
    encryptedApiKey: "envelope",
  });
  mocks.variantFindFirst.mockResolvedValue({ loyverseId: "lv-var-1" });
  mocks.storeFindFirst.mockResolvedValue({ loyverseStoreId: "seed-store-1" });
});

describe("enqueueStockWriteback", () => {
  it("records a PENDING row with a sanitized payload and schedules delivery", async () => {
    mocks.stockWritebackRequestCreate.mockResolvedValue({ id: "wb-1" });

    const result = await enqueueStockWriteback({
      organizationId: "org-1",
      variantId: "v-1",
      storeId: "store-1",
      quantity: new Prisma.Decimal("12.000"),
      reason: "Purchase order receiving",
      referenceType: "PURCHASE_ORDER",
      referenceId: "po-1",
    });

    expect(result).toEqual({ id: "wb-1" });
    expect(mocks.stockWritebackRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        variantId: "v-1",
        storeId: "store-1",
        reason: "Purchase order receiving",
        referenceType: "PURCHASE_ORDER",
        referenceId: "po-1",
        status: "PENDING",
        requestPayload: {
          variantId: "v-1",
          storeId: "store-1",
          quantity: "12",
          reason: "Purchase order receiving",
        },
      }),
      select: { id: true },
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "write-back-stock",
      { stockWritebackRequestId: "wb-1", organizationId: "org-1" },
      { jobId: "writeback-wb-1" },
    );
  });
});

describe("performStockWriteback", () => {
  const REQUEST = {
    id: "wb-1",
    organizationId: "org-1",
    variantId: "v-1",
    storeId: "store-1",
    quantity: "12.000",
  };

  it("POSTs absolute stock_after to Loyverse and stamps SUCCEEDED", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        inventory_levels: [
          { variant_id: "lv-var-1", store_id: "seed-store-1", in_stock: 12, updated_at: "2026-09-10T00:00:00Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await performStockWriteback("wb-1", "org-1");

    expect(result).toEqual({ status: "SUCCEEDED" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.loyverse.com/v1.0/inventory");
    expect(JSON.parse(init.body as string)).toEqual({
      inventory_levels: [
        { variant_id: "lv-var-1", store_id: "seed-store-1", stock_after: 12 },
      ],
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(mocks.stockWritebackRequestUpdate).toHaveBeenCalledWith({
      where: { id: "wb-1" },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        responseStatus: 200,
        completedAt: expect.any(Date),
      }),
    });
  });

  it("falls back to the org's primary store when the request has none", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue({ ...REQUEST, storeId: null });
    // A null storeId skips the explicit-store lookup entirely; the single
    // storeFindFirst call is the primary-store fallback (beforeEach default).
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await performStockWriteback("wb-1", "org-1");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).inventory_levels[0].store_id).toBe("seed-store-1");
  });

  it("401/403 → FAILED row + UnrecoverableError (reconnect)", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { message: "unauthorized" })));

    await expect(performStockWriteback("wb-1", "org-1")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.stockWritebackRequestUpdate).toHaveBeenCalledWith({
      where: { id: "wb-1" },
      data: expect.objectContaining({ status: "FAILED", responseStatus: 401 }),
    });
  });

  it("network failure → FAILED row + TransientJobError (retry)", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hangup")));

    await expect(performStockWriteback("wb-1", "org-1")).rejects.toBeInstanceOf(TransientJobError);
    expect(mocks.stockWritebackRequestUpdate).toHaveBeenCalledWith({
      where: { id: "wb-1" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("429 → FAILED row + TransientJobError (retry)", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {})));

    await expect(performStockWriteback("wb-1", "org-1")).rejects.toBeInstanceOf(TransientJobError);
  });

  it("unknown request id → UnrecoverableError without touching Loyverse", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(performStockWriteback("missing", "org-1")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unsynced variant → InventoryError, no Loyverse call", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    mocks.variantFindFirst.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(performStockWriteback("wb-1", "org-1")).rejects.toMatchObject({
      name: "InventoryError",
      code: "VARIANT_NOT_SYNCED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never persists the API key anywhere (§24)", async () => {
    mocks.stockWritebackRequestFindFirst.mockResolvedValue(REQUEST);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { inventory_levels: [] })));

    await performStockWriteback("wb-1", "org-1");

    const persisted = JSON.stringify({
      create: mocks.stockWritebackRequestCreate.mock.calls,
      update: mocks.stockWritebackRequestUpdate.mock.calls,
    });
    expect(persisted).not.toContain(SECRET_KEY);
    expect(persisted).not.toContain("Bearer");
    expect(persisted).not.toContain("Authorization");
  });
});
