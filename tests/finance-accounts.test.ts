/**
 * Chart of accounts use-cases (SPEC.md §6/§7, issue #10). Org-scoped CRUD:
 * code unique per org (immutable after creation — enforced by the update
 * schema simply omitting it), active/inactive replaces deletion, store
 * applicability must reference a store in the same org. Failures surface as
 * operator-safe FinanceError (§19), never raw driver errors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAccount,
  listAccounts,
  updateAccount,
} from "@/lib/finance/accounts";
import { FinanceError } from "@/lib/finance/errors";

const mocks = vi.hoisted(() => ({
  gLAccountFindMany: vi.fn(),
  gLAccountFindFirst: vi.fn(),
  gLAccountCreate: vi.fn(),
  gLAccountUpdate: vi.fn(),
  storeFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    gLAccount: {
      findMany: mocks.gLAccountFindMany,
      findFirst: mocks.gLAccountFindFirst,
      create: mocks.gLAccountCreate,
      update: mocks.gLAccountUpdate,
    },
    store: { findFirst: mocks.storeFindFirst },
  },
}));

const ACCOUNT = {
  id: "acct-1",
  code: "4000",
  name: "Sales Revenue",
  type: "REVENUE",
  active: true,
  store: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeFindFirst.mockResolvedValue({ id: "store-1" });
  mocks.gLAccountCreate.mockResolvedValue(ACCOUNT);
  mocks.gLAccountUpdate.mockResolvedValue(ACCOUNT);
});

describe("createAccount", () => {
  const valid = { code: "4050", name: "Card Sales", type: "REVENUE" };

  it("creates a company-wide account by default", async () => {
    const account = await createAccount("org-1", valid);
    expect(mocks.gLAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: "org-1", code: "4050", active: true, storeId: null }),
      }),
    );
    expect(account.code).toBe("4000");
  });

  it.each([
    [{ ...valid, code: "" }, "code"],
    [{ ...valid, name: "" }, "name"],
    [{ ...valid, type: "BANANA" }, "type"],
  ])("rejects invalid input %o with a safe VALIDATION_ERROR", async (input) => {
    await expect(createAccount("org-1", input)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.gLAccountCreate).not.toHaveBeenCalled();
  });

  it("maps the unique (org, code) violation to a safe 409", async () => {
    mocks.gLAccountCreate.mockRejectedValue({ code: "P2002" });
    await expect(createAccount("org-1", valid)).rejects.toMatchObject({
      status: 409,
      code: "ACCOUNT_CODE_EXISTS",
    });
  });

  it("rejects a storeId outside the org (no cross-tenant FKs)", async () => {
    mocks.storeFindFirst.mockResolvedValue(null);
    await expect(createAccount("org-1", { ...valid, storeId: "store-evil" })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.gLAccountCreate).not.toHaveBeenCalled();
  });

  it("allows a store-scoped account when the store belongs to the org", async () => {
    await createAccount("org-1", { ...valid, storeId: "store-1" });
    expect(mocks.gLAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storeId: "store-1" }) }),
    );
  });
});

describe("updateAccount", () => {
  it("updates name/type/active/applicability on the org-scoped account", async () => {
    mocks.gLAccountFindFirst.mockResolvedValue({ id: "acct-1" });
    await updateAccount("org-1", "acct-1", { name: "Renamed", active: false });
    expect(mocks.gLAccountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acct-1" },
        data: { name: "Renamed", active: false },
      }),
    );
  });

  it("404s when the account is missing or belongs to another org", async () => {
    mocks.gLAccountFindFirst.mockResolvedValue(null);
    await expect(updateAccount("org-1", "acct-other", { name: "X" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(mocks.gLAccountUpdate).not.toHaveBeenCalled();
  });

  it("partial updates only touch provided fields", async () => {
    mocks.gLAccountFindFirst.mockResolvedValue({ id: "acct-1" });
    await updateAccount("org-1", "acct-1", { active: false });
    expect(mocks.gLAccountUpdate.mock.calls[0][0].data).toEqual({ active: false });
  });
});

describe("listAccounts", () => {
  it("lists org accounts ordered by code with store applicability", async () => {
    mocks.gLAccountFindMany.mockResolvedValue([
      { ...ACCOUNT, code: "1000" },
      { ...ACCOUNT, code: "4000", store: { id: "store-1", name: "Downtown" } },
    ]);
    const accounts = await listAccounts("org-1");
    expect(mocks.gLAccountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1" } }),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[1].store).toEqual({ id: "store-1", name: "Downtown" });
  });
});

describe("FinanceError safety", () => {
  it("carries only status, code, and an operator-safe message", async () => {
    const error = new FinanceError(400, "VALIDATION_ERROR", "Account name is required.");
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("Account name is required.");
    expect(Object.keys(error).sort()).toEqual(["code", "name", "status"]);
  });
});
