import type { SyncRun } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.KEY_VERSION = "v1";

const mocks = vi.hoisted(() => ({
  paginate: vi.fn(),
  validateApiKey: vi.fn(),
  loyverseConnectionFindUnique: vi.fn(),
  loyverseConnectionUpdate: vi.fn(),
  syncRunUpdate: vi.fn(),
  storeUpsert: vi.fn(),
  storeFindUnique: vi.fn(),
  categoryUpsert: vi.fn(),
  categoryFindUnique: vi.fn(),
  categoryUpdate: vi.fn(),
  itemUpsert: vi.fn(),
  variantUpsert: vi.fn(),
  variantFindUnique: vi.fn(),
  employeeUpsert: vi.fn(),
  employeeFindUnique: vi.fn(),
  customerUpsert: vi.fn(),
  customerFindUnique: vi.fn(),
  receiptUpsert: vi.fn(),
  refundUpsert: vi.fn(),
  // Step-11 baseline COA hook (#10)
  gLAccountUpsert: vi.fn(),
  gLAccountFindUnique: vi.fn(),
  gLMappingFindMany: vi.fn(),
  gLMappingCreate: vi.fn(),
}));

vi.mock("@/lib/loyverse/client", () => ({
  LOYVERSE_API_BASE: "https://stub.test/v1.0",
  loyverseApiBase: () => "https://stub.test/v1.0",
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/loyverse/http", () => ({
  LoyverseHttp: class {
    paginate = mocks.paginate;
  },
  defaultSleep: async () => {},
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    loyverseConnection: {
      findUnique: mocks.loyverseConnectionFindUnique,
      update: mocks.loyverseConnectionUpdate,
    },
    syncRun: { update: mocks.syncRunUpdate },
    store: { upsert: mocks.storeUpsert, findUnique: mocks.storeFindUnique },
    category: {
      upsert: mocks.categoryUpsert,
      findUnique: mocks.categoryFindUnique,
      update: mocks.categoryUpdate,
    },
    item: { upsert: mocks.itemUpsert },
    variant: { upsert: mocks.variantUpsert, findUnique: mocks.variantFindUnique },
    employee: { upsert: mocks.employeeUpsert, findUnique: mocks.employeeFindUnique },
    customer: { upsert: mocks.customerUpsert, findUnique: mocks.customerFindUnique },
    receipt: { upsert: mocks.receiptUpsert },
    refund: { upsert: mocks.refundUpsert },
    gLAccount: { upsert: mocks.gLAccountUpsert, findUnique: mocks.gLAccountFindUnique },
    gLMapping: { findMany: mocks.gLMappingFindMany, create: mocks.gLMappingCreate },
  },
}));

import { encryptSecret } from "@/lib/encryption";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";
import {
  parseLoyverseDate,
  RESOURCE_ORDER,
  runLoyverseSync,
} from "@/lib/loyverse/sync/engine";

// ---------------------------------------------------------------------------
// Stub Loyverse dataset (mirrors what the E2E stub server serves)
// ---------------------------------------------------------------------------

function receipt(id: string, storeId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    store_id: storeId,
    employee_id: "e1",
    customer_id: "cu1",
    receipt_number: `R-${id}`,
    payment_type: "CASH",
    subtotal: 10,
    total_money: 10,
    created_at: "2024-01-15 10:30:45 +0000",
    line_items: [
      { item_name: "Coffee", variant_id: "v1", quantity: 2, price: 5, total_money: 10 },
    ],
    refunds:
      id === "r1"
        ? [
            {
              id: "rf1",
              total_money: 10,
              reason: "spoiled",
              line_items: [
                { item_name: "Coffee", variant_id: "v1", quantity: 2, price: 5, total_money: 10 },
              ],
            },
          ]
        : [],
    ...extra,
  };
}

const FIXTURE: Record<string, { items: Record<string, unknown>[]; cursor: string | null }[]> = {
  "/stores": [
    {
      items: [
        { id: "s1", name: "Downtown", address: { line1: "1 Main St" }, timezone: "UTC" },
        { id: "s2", name: "Mall" },
      ],
      cursor: null,
    },
  ],
  "/categories": [
    { items: [{ id: "c1", name: "Drinks" }, { id: "c2", name: "Hot", parent_id: "c1" }], cursor: null },
  ],
  "/items": [
    {
      items: [
        {
          id: "i1",
          item_name: "Coffee",
          category_id: "c1",
          item_type: "STOCK",
          variants: [
            { id: "v1", name: "Small", sku: "CF-S", price: 5, default_cost: 2 },
            { id: "v2", name: "Large", sku: "CF-L", price: 7 },
          ],
        },
        {
          id: "i2",
          item_name: "Tea",
          variants: [{ id: "v3", name: "Pot", price: 6 }],
        },
      ],
      cursor: null,
    },
  ],
  "/employees": [{ items: [{ id: "e1", name: "Ada", email: "ada@biz.test", role: "CASHIER" }], cursor: null }],
  "/customers": [
    {
      items: [
        { id: "cu1", name: "Sam", email: "sam@biz.test", phone_number: "123" },
        { id: "cu2", name: "Jo" },
      ],
      cursor: null,
    },
  ],
  "/receipts": [
    { items: [receipt("r1", "s1"), receipt("r2", "s2")], cursor: "c-page-2" },
    { items: [receipt("r3", "s1")], cursor: null },
  ],
};

function pagesFor(path: string, cursor?: string) {
  const all = FIXTURE[path] ?? [];
  // Loyverse cursor semantics: a cursor resumes AFTER the page that produced
  // it (our fixture names each page's continuation cursor after itself).
  const start = cursor ? all.findIndex((p) => p.cursor === cursor) + 1 : 0;
  const pages = start > 0 ? all.slice(start) : all;
  return (async function* () {
    for (const page of pages) yield page;
  })();
}

const FULL_COUNTS = {
  stores: 2,
  categories: 2,
  items: 2,
  variants: 3,
  employees: 1,
  customers: 2,
  receipts: 3,
  refunds: 1,
};

let run: SyncRun;
let connection: { organizationId: string; encryptedApiKey: string; lastSyncAt: Date | null };

function makeRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: "run-1",
    organizationId: "org-1",
    type: "INITIAL",
    startedAt: new Date("2026-09-09T00:00:00Z"),
    finishedAt: null,
    status: "RUNNING",
    counts: null,
    errorSummary: null,
    progress: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  run = makeRun();
  connection = {
    organizationId: "org-1",
    encryptedApiKey: encryptSecret("stub-key"),
    lastSyncAt: null,
  };
  mocks.validateApiKey.mockResolvedValue({ ok: true, businessName: "Stub Biz" });
  mocks.loyverseConnectionFindUnique.mockResolvedValue(connection);
  mocks.paginate.mockImplementation(
    (path: string, params: { cursor?: string } = {}) => pagesFor(path, params.cursor),
  );
  // Local-id lookups resolve deterministically from the Loyverse id.
  const byLoyverseId = (args: { where: { organizationId_loyverseId: { loyverseId: string } } }) => ({
    id: `local-${args.where.organizationId_loyverseId.loyverseId}`,
  });
  mocks.storeFindUnique.mockImplementation(
    (args: { where: { organizationId_loyverseStoreId: { loyverseStoreId: string } } }) => ({
      id: `local-${args.where.organizationId_loyverseStoreId.loyverseStoreId}`,
    }),
  );
  mocks.categoryFindUnique.mockImplementation(byLoyverseId);
  mocks.variantFindUnique.mockImplementation(byLoyverseId);
  mocks.employeeFindUnique.mockImplementation(byLoyverseId);
  mocks.customerFindUnique.mockImplementation(byLoyverseId);
  mocks.itemUpsert.mockResolvedValue({ id: "local-item" });
  mocks.receiptUpsert.mockResolvedValue({ id: "local-receipt" });
  // Step-11 baseline COA hook (#10): accounts upsert, default payment
  // mappings created only when unmapped.
  mocks.gLAccountUpsert.mockResolvedValue({ id: "acct" });
  mocks.gLAccountFindUnique.mockImplementation(
    (args: { where: { organizationId_code: { code: string } } }) => ({
      id: `local-${args.where.organizationId_code.code}`,
    }),
  );
  mocks.gLMappingFindMany.mockResolvedValue([]);
  mocks.gLMappingCreate.mockResolvedValue({ id: "map" });
});

describe("runLoyverseSync (SPEC.md §9 ordered sequence)", () => {
  it("validates the credential first, then syncs resources in §9 order", async () => {
    await runLoyverseSync(run);

    const paths = mocks.paginate.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([...RESOURCE_ORDER].map((r) => `/${r}`));
    expect(mocks.validateApiKey.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paginate.mock.invocationCallOrder[0],
    );
  });

  it("returns counts matching the stub dataset and stamps lastSyncAt", async () => {
    const { counts } = await runLoyverseSync(run);
    expect(counts).toEqual(FULL_COUNTS);
    expect(mocks.loyverseConnectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        data: expect.objectContaining({ lastSyncAt: expect.any(Date) }),
      }),
    );
  });

  it("runs the step-11 post-sync checklist: baseline accounts upserted, only unmapped payment types get default mappings", async () => {
    await runLoyverseSync(run);
    expect(mocks.gLAccountUpsert).toHaveBeenCalledTimes(12); // BASELINE_COA
    // No payment mappings existed → Cash + Card defaults created.
    expect(mocks.gLMappingCreate).toHaveBeenCalledTimes(2);
    expect(mocks.gLMappingCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ paymentType: "Cash", accountId: "local-1000" }),
    );
    expect(mocks.gLMappingCreate.mock.calls[1][0].data).toEqual(
      expect.objectContaining({ paymentType: "Card", accountId: "local-1010" }),
    );

    vi.clearAllMocks();
    mocks.gLMappingFindMany.mockResolvedValue([{ paymentType: "Cash" }, { paymentType: "Card" }]);
    await runLoyverseSync(run);
    // Both defaults already mapped → no new mappings, accounts still ensured.
    expect(mocks.gLMappingCreate).not.toHaveBeenCalled();
    expect(mocks.gLAccountUpsert).toHaveBeenCalledTimes(12);
  });

  it("scopes every upsert to the organization + Loyverse id", async () => {
    await runLoyverseSync(run);
    for (const call of mocks.storeUpsert.mock.calls) {
      expect(call[0].where.organizationId_loyverseStoreId.organizationId).toBe("org-1");
    }
    for (const call of mocks.receiptUpsert.mock.calls) {
      expect(call[0].where.organizationId_loyverseId.organizationId).toBe("org-1");
    }
  });

  it("paginates cursor endpoints to completion (both receipts pages)", async () => {
    const { counts } = await runLoyverseSync(run);
    const receiptCalls = mocks.paginate.mock.calls.filter((c) => c[0] === "/receipts");
    expect(receiptCalls).toHaveLength(1); // one generator…
    expect(counts.receipts).toBe(3); // …consuming two pages
    expect(counts.refunds).toBe(1);
  });

  it("persists a mid-resource checkpoint after each paginated page", async () => {
    await runLoyverseSync(run);
    const checkpoint = mocks.syncRunUpdate.mock.calls.find(
      (c) => c[0].data.progress?.cursors?.receipts === "c-page-2",
    );
    expect(checkpoint).toBeDefined();
    // Page checkpoints carry cumulative counts, including this page's items.
    expect(checkpoint![0].data.counts.stores).toBe(2);
    expect(checkpoint![0].data.counts.receipts).toBe(2);
  });

  it("resumes: skips done resources, continues from the stored cursor", async () => {
    run = makeRun({
      progress: {
        done: ["stores", "categories", "items", "employees", "customers"],
        cursors: { receipts: "c-page-2" },
      },
      // Counts as a real mid-run checkpoint would carry them: page 1's two
      // receipts (and their refund) already merged.
      counts: {
        stores: 2, categories: 2, items: 2, variants: 3,
        employees: 1, customers: 2, receipts: 2, refunds: 1,
      },
    });

    const { counts } = await runLoyverseSync(run);

    const paths = mocks.paginate.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(["/receipts"]); // earlier resources not re-fetched
    expect(mocks.paginate.mock.calls[0][1].cursor).toBe("c-page-2"); // resumes mid-resource
    expect(counts).toEqual(FULL_COUNTS); // cumulative with the persisted counts
  });

  it("survives an injected mid-run failure and resumes with cumulative counts", async () => {
    async function* receiptsFailAfterPageOne() {
      yield { items: [receipt("r1", "s1"), receipt("r2", "s2")], cursor: "c-page-2" };
      throw new TransientJobError("injected mid-run failure");
    }
    mocks.paginate.mockImplementation((path: string) =>
      path === "/receipts" ? receiptsFailAfterPageOne() : pagesFor(path),
    );

    // Attempt 1: processes five resources, then dies inside receipts.
    await expect(runLoyverseSync(run)).rejects.toThrow("injected mid-run failure");
    const saved = mocks.syncRunUpdate.mock.calls.at(-1)![0].data;
    expect(saved.progress.done).toEqual(["stores", "categories", "items", "employees", "customers"]);
    expect(saved.progress.cursors.receipts).toBe("c-page-2");
    expect(saved.counts).toMatchObject({ stores: 2, receipts: 2 });

    // Attempt 2 (BullMQ retry): resumes from the checkpoint only.
    mocks.paginate.mockImplementation(
    (path: string, params: { cursor?: string } = {}) => pagesFor(path, params.cursor),
  );
    run = makeRun({ progress: saved.progress, counts: saved.counts });
    const { counts } = await runLoyverseSync(run);

    const paths = mocks.paginate.mock.calls.map((c) => c[0]);
    expect(paths.filter((p) => p === "/stores")).toHaveLength(1); // not re-fetched on the retry
    expect(counts).toEqual(FULL_COUNTS);
  });

  it("incremental runs pass the since-filter and ignore done checkpoints", async () => {
    const since = new Date("2026-09-01T00:00:00Z");
    connection.lastSyncAt = since;
    run = makeRun({
      type: "INCREMENTAL",
      progress: { done: [...RESOURCE_ORDER], cursors: {} },
    });

    await runLoyverseSync(run);

    expect(mocks.paginate).toHaveBeenCalledTimes(RESOURCE_ORDER.length);
    const receiptsCall = mocks.paginate.mock.calls.find((c) => c[0] === "/receipts");
    const itemsCall = mocks.paginate.mock.calls.find((c) => c[0] === "/items");
    expect(receiptsCall![1].created_at_min).toBe(since.toISOString());
    expect(itemsCall![1].updated_at_min).toBe(since.toISOString());
  });

  it("fails permanently when the stored key is rejected (reconnect required)", async () => {
    mocks.validateApiKey.mockResolvedValue({ ok: false, reason: "invalid" });
    await expect(runLoyverseSync(run)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.paginate).not.toHaveBeenCalled();
  });

  it("retries transiently when Loyverse is unreachable before syncing", async () => {
    mocks.validateApiKey.mockResolvedValue({ ok: false, reason: "unavailable" });
    await expect(runLoyverseSync(run)).rejects.toBeInstanceOf(TransientJobError);
    expect(mocks.paginate).not.toHaveBeenCalled();
  });

  it("fails permanently when no connection exists", async () => {
    mocks.loyverseConnectionFindUnique.mockResolvedValue(null);
    await expect(runLoyverseSync(run)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("skips receipts whose store is unknown instead of breaking the FK", async () => {
    mocks.storeFindUnique.mockImplementation(
      (args: { where: { organizationId_loyverseStoreId: { loyverseStoreId: string } } }) =>
        args.where.organizationId_loyverseStoreId.loyverseStoreId === "s-gone"
          ? null
          : { id: `local-${args.where.organizationId_loyverseStoreId.loyverseStoreId}` },
    );
    FIXTURE["/receipts"] = [
      { items: [receipt("rX", "s-gone"), receipt("r1", "s1")], cursor: null },
    ];
    try {
      const { counts } = await runLoyverseSync(run);
      expect(counts.receipts).toBe(1);
    } finally {
      FIXTURE["/receipts"] = [
        { items: [receipt("r1", "s1"), receipt("r2", "s2")], cursor: "c-page-2" },
        { items: [receipt("r3", "s1")], cursor: null },
      ];
    }
  });
});

describe("parseLoyverseDate", () => {
  it("parses Loyverse's 'YYYY-MM-DD HH:MM:SS +0000' format", () => {
    const date = parseLoyverseDate("2024-01-15 10:30:45 +0000");
    expect(date).not.toBeNull();
    expect(date!.toISOString()).toBe("2024-01-15T10:30:45.000Z");
  });

  it("parses ISO strings and rejects garbage", () => {
    expect(parseLoyverseDate("2024-01-15T10:30:45Z")!.toISOString()).toBe("2024-01-15T10:30:45.000Z");
    expect(parseLoyverseDate("not a date")).toBeNull();
    expect(parseLoyverseDate(null)).toBeNull();
    expect(parseLoyverseDate(12345)).toBeNull();
  });
});
