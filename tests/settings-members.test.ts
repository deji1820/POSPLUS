/**
 * Users & roles settings use-cases (SPEC.md §5 RBAC, §6 Settings, §17).
 * Contract: org-scoped membership management; invite links an existing user
 * or creates a placeholder (no email infra); role/status changes 404 out of
 * tenant and no-op on unchanged values; store/warehouse scope is tenant
 * validated and only applies to the scoped roles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
  membershipCreate: vi.fn(),
  membershipUpdate: vi.fn(),
  storeAccessFindMany: vi.fn(),
  warehouseAccessFindMany: vi.fn(),
  storeAccessDeleteMany: vi.fn(),
  storeAccessCreateMany: vi.fn(),
  warehouseAccessDeleteMany: vi.fn(),
  warehouseAccessCreateMany: vi.fn(),
  storeCount: vi.fn(),
  warehouseCount: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
    organizationMembership: {
      findUnique: mocks.membershipFindUnique,
      findFirst: mocks.membershipFindFirst,
      findMany: mocks.membershipFindMany,
      create: mocks.membershipCreate,
      update: mocks.membershipUpdate,
    },
    userStoreAccess: {
      findMany: mocks.storeAccessFindMany,
      deleteMany: mocks.storeAccessDeleteMany,
      createMany: mocks.storeAccessCreateMany,
    },
    userWarehouseAccess: {
      findMany: mocks.warehouseAccessFindMany,
      deleteMany: mocks.warehouseAccessDeleteMany,
      createMany: mocks.warehouseAccessCreateMany,
    },
    store: { count: mocks.storeCount },
    warehouse: { count: mocks.warehouseCount },
    $transaction: mocks.$transaction,
  },
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: () => "scrypt:salt:hash",
  verifyScryptPassword: () => false,
}));

import {
  changeRole,
  inviteUser,
  setMembershipStatus,
  setStoreScope,
  setWarehouseScope,
} from "@/lib/settings/members";
import { SettingsError } from "@/lib/settings/errors";

beforeEach(() => vi.clearAllMocks());

const membershipRow = {
  id: "m-1",
  userId: "u-1",
  role: "STORE_MANAGER",
  status: "ACTIVE",
  user: { email: "mgr@x.com", name: "Mgr" },
};

describe("inviteUser", () => {
  it("links an existing user with the given role", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "u-1", email: "mgr@x.com" });
    mocks.membershipFindUnique.mockResolvedValue(null);
    mocks.membershipCreate.mockResolvedValue(membershipRow);
    mocks.storeAccessFindMany.mockResolvedValue([]);
    mocks.warehouseAccessFindMany.mockResolvedValue([]);

    const created = await inviteUser("org-1", { email: "mgr@x.com", role: "STORE_MANAGER" });
    expect(created.role).toBe("STORE_MANAGER");
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("creates a placeholder account when the email has no user", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "u-new", email: "new@x.com" });
    mocks.membershipFindUnique.mockResolvedValue(null);
    mocks.membershipCreate.mockResolvedValue({ ...membershipRow, userId: "u-new", user: { email: "new@x.com", name: "new" } });
    mocks.storeAccessFindMany.mockResolvedValue([]);
    mocks.warehouseAccessFindMany.mockResolvedValue([]);

    await inviteUser("org-1", { email: "new@x.com", role: "ACCOUNTANT" });
    expect(mocks.userCreate).toHaveBeenCalled();
  });

  it("rejects a duplicate membership in the org", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "u-1", email: "mgr@x.com" });
    mocks.membershipFindUnique.mockResolvedValue(membershipRow);
    await expect(inviteUser("org-1", { email: "mgr@x.com", role: "ACCOUNTANT" })).rejects.toBeInstanceOf(SettingsError);
  });
});

describe("changeRole", () => {
  it("returns before/after and rejects an unchanged role", async () => {
    mocks.membershipFindFirst.mockResolvedValue(membershipRow);
    mocks.storeAccessFindMany.mockResolvedValue([]);
    mocks.warehouseAccessFindMany.mockResolvedValue([]);
    await expect(changeRole("org-1", { membershipId: "m-1", role: "STORE_MANAGER" })).rejects.toBeInstanceOf(SettingsError);

    mocks.membershipUpdate.mockResolvedValue({ ...membershipRow, role: "ACCOUNTANT" });
    const { before, after } = await changeRole("org-1", { membershipId: "m-1", role: "ACCOUNTANT" });
    expect(before.role).toBe("STORE_MANAGER");
    expect(after.role).toBe("ACCOUNTANT");
  });

  it("404s an out-of-tenant membership", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);
    await expect(changeRole("org-1", { membershipId: "m-x", role: "ACCOUNTANT" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("setMembershipStatus", () => {
  it("deactivates an active membership", async () => {
    mocks.membershipFindFirst.mockResolvedValue(membershipRow);
    mocks.storeAccessFindMany.mockResolvedValue([]);
    mocks.warehouseAccessFindMany.mockResolvedValue([]);
    mocks.membershipUpdate.mockResolvedValue({ ...membershipRow, status: "DISABLED" });
    const { after } = await setMembershipStatus("org-1", { membershipId: "m-1", status: "DISABLED" });
    expect(after.status).toBe("DISABLED");
  });
});

describe("setStoreScope", () => {
  it("replaces scope in a transaction for a store-scoped role", async () => {
    mocks.membershipFindFirst.mockResolvedValue(membershipRow); // STORE_MANAGER
    mocks.storeCount.mockResolvedValue(2);
    mocks.$transaction.mockResolvedValue([]);
    const result = await setStoreScope("org-1", { membershipId: "m-1", storeIds: ["s-1", "s-2"] });
    expect(result.storeIds).toEqual(["s-1", "s-2"]);
    expect(mocks.$transaction).toHaveBeenCalled();
  });

  it("rejects scope on a non-store-scoped role", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ ...membershipRow, role: "ACCOUNTANT" });
    await expect(setStoreScope("org-1", { membershipId: "m-1", storeIds: ["s-1"] })).rejects.toBeInstanceOf(SettingsError);
  });

  it("rejects stores outside the tenant", async () => {
    mocks.membershipFindFirst.mockResolvedValue(membershipRow);
    mocks.storeCount.mockResolvedValue(1); // one of two is foreign
    await expect(setStoreScope("org-1", { membershipId: "m-1", storeIds: ["s-1", "s-foreign"] })).rejects.toBeInstanceOf(SettingsError);
  });
});

describe("setWarehouseScope", () => {
  it("replaces warehouse scope for a warehouse-scoped role", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ ...membershipRow, role: "WAREHOUSE_STAFF" });
    mocks.warehouseCount.mockResolvedValue(1);
    mocks.$transaction.mockResolvedValue([]);
    const result = await setWarehouseScope("org-1", { membershipId: "m-1", warehouseIds: ["w-1"] });
    expect(result.warehouseIds).toEqual(["w-1"]);
  });
});
