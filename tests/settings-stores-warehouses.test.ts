/**
 * Store + warehouse settings use-cases (SPEC.md §6 Settings). Contract:
 * tenant-isolated reads/writes, Loyverse-id and warehouse-code uniqueness
 * within the org, linked-store/warehouse must belong to the org, and
 * update returns before/after snapshots for the audit trail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeFindMany: vi.fn(),
  storeFindFirst: vi.fn(),
  storeCreate: vi.fn(),
  storeUpdate: vi.fn(),
  warehouseFindMany: vi.fn(),
  warehouseFindFirst: vi.fn(),
  warehouseCreate: vi.fn(),
  warehouseUpdate: vi.fn(),
  storeCount: vi.fn(),
  warehouseCount: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    store: {
      findMany: mocks.storeFindMany,
      findFirst: mocks.storeFindFirst,
      create: mocks.storeCreate,
      update: mocks.storeUpdate,
      count: mocks.storeCount,
    },
    warehouse: {
      findMany: mocks.warehouseFindMany,
      findFirst: mocks.warehouseFindFirst,
      create: mocks.warehouseCreate,
      update: mocks.warehouseUpdate,
      count: mocks.warehouseCount,
    },
    $transaction: mocks.$transaction,
  },
}));

import { createStore, updateStore } from "@/lib/settings/stores";
import { createWarehouse, updateWarehouse } from "@/lib/settings/warehouses";
import { SettingsError } from "@/lib/settings/errors";

beforeEach(() => vi.clearAllMocks());

describe("stores", () => {
  it("creates a store and rejects a duplicate loyverseStoreId in the org", async () => {
    mocks.storeFindFirst.mockResolvedValueOnce({ id: "other" });
    await expect(
      createStore("org-1", { name: "S2", loyverseStoreId: "lv-1", active: true }),
    ).rejects.toBeInstanceOf(SettingsError);

    mocks.storeFindFirst.mockResolvedValueOnce(null);
    mocks.storeCreate.mockResolvedValue({ id: "s-1", name: "S2", address: null, timezone: null, loyverseStoreId: "lv-1", active: true });
    const created = await createStore("org-1", { name: "S2", loyverseStoreId: "lv-1", active: true });
    expect(created.id).toBe("s-1");
  });

  it("update returns before/after and 404s an out-of-tenant store", async () => {
    mocks.storeFindFirst.mockResolvedValueOnce(null);
    await expect(
      updateStore("org-1", { id: "s-x", name: "S", active: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    mocks.storeFindFirst.mockResolvedValueOnce({ id: "s-1", name: "Old", address: null, timezone: null, loyverseStoreId: null, active: true });
    mocks.storeUpdate.mockResolvedValue({ id: "s-1", name: "New", address: null, timezone: null, loyverseStoreId: null, active: false });
    const { before, after } = await updateStore("org-1", { id: "s-1", name: "New", active: false });
    expect(before.name).toBe("Old");
    expect(after.name).toBe("New");
  });
});

const warehouseSelectRow = { id: "w-1", name: "Main", code: "WH-01", storeId: "s-1", active: true, store: { name: "Store 1" } };

describe("warehouses", () => {
  it("creates a warehouse with a linked store after validating tenant ownership", async () => {
    mocks.storeFindFirst.mockResolvedValue({ id: "s-1" });
    mocks.warehouseFindFirst.mockResolvedValue(null);
    mocks.warehouseCreate.mockResolvedValue(warehouseSelectRow);
    const created = await createWarehouse("org-1", { name: "Main", code: "WH-01", storeId: "s-1", active: true });
    expect(created.storeName).toBe("Store 1");
    expect(mocks.storeFindFirst).toHaveBeenCalledWith({ where: { id: "s-1", organizationId: "org-1" }, select: { id: true } });
  });

  it("rejects a store outside the tenant", async () => {
    mocks.storeFindFirst.mockResolvedValue(null);
    await expect(
      createWarehouse("org-1", { name: "Main", code: "WH-01", storeId: "s-other", active: true }),
    ).rejects.toBeInstanceOf(SettingsError);
  });

  it("rejects a duplicate code in the org", async () => {
    mocks.storeFindFirst.mockResolvedValue({ id: "s-1" });
    mocks.warehouseFindFirst.mockResolvedValue({ id: "w-2" });
    await expect(
      createWarehouse("org-1", { name: "Main", code: "WH-01", active: true }),
    ).rejects.toBeInstanceOf(SettingsError);
  });

  it("update returns before/after", async () => {
    mocks.warehouseFindFirst.mockResolvedValueOnce(warehouseSelectRow);
    mocks.storeFindFirst.mockResolvedValue({ id: "s-1" });
    mocks.warehouseFindFirst.mockResolvedValueOnce(null); // code free
    const updatedRow = { ...warehouseSelectRow, name: "Central" };
    mocks.warehouseUpdate.mockResolvedValue(updatedRow);
    const { before, after } = await updateWarehouse("org-1", { id: "w-1", name: "Central", code: "WH-01", storeId: "s-1", active: true });
    expect(before.name).toBe("Main");
    expect(after.name).toBe("Central");
  });
});
