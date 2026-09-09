/**
 * GL mapping use-cases (SPEC.md §6/§7, issue #10). PUT replaces the org's
 * entire mapping set in one transaction; every row is validated up front
 * (exactly one of paymentType/categoryId, no duplicate keys, category and
 * account must exist in the org, account must be active) and ANY invalid row
 * rejects the whole set with an operator-safe error — auto-posting (#11)
 * must never read a silently partial configuration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listMappings, replaceMappings } from "@/lib/finance/mappings";

const mocks = vi.hoisted(() => ({
  gLMappingFindMany: vi.fn(),
  gLMappingDeleteMany: vi.fn(),
  gLMappingCreateMany: vi.fn(),
  categoryFindMany: vi.fn(),
  gLAccountFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    gLMapping: {
      findMany: mocks.gLMappingFindMany,
      deleteMany: mocks.gLMappingDeleteMany,
      createMany: mocks.gLMappingCreateMany,
    },
    category: { findMany: mocks.categoryFindMany },
    gLAccount: { findMany: mocks.gLAccountFindMany },
    $transaction: mocks.transaction,
  },
}));

const CASH_ROW = { paymentType: "Cash", accountId: "acct-1000" };
const CARD_ROW = { paymentType: "Card", accountId: "acct-1010" };
const CATEGORY_ROW = { categoryId: "cat-1", accountId: "acct-4000" };

const LISTED = [
  {
    id: "map-1",
    paymentType: "Cash",
    category: null,
    account: { id: "acct-1000", code: "1000", name: "Cash on Hand" },
  },
  {
    id: "map-2",
    paymentType: null,
    category: { id: "cat-1", name: "Beverages" },
    account: { id: "acct-4000", code: "4000", name: "Sales Revenue" },
  },
];

function setupValidRefs() {
  mocks.categoryFindMany.mockResolvedValue([{ id: "cat-1" }]);
  mocks.gLAccountFindMany.mockResolvedValue([
    { id: "acct-1000", active: true },
    { id: "acct-1010", active: true },
    { id: "acct-4000", active: true },
  ]);
  mocks.transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
  mocks.gLMappingFindMany.mockResolvedValue(LISTED);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupValidRefs();
});

describe("replaceMappings", () => {
  it("replaces the whole set in one transaction and returns the new mappings", async () => {
    const result = await replaceMappings("org-1", { mappings: [CASH_ROW, CARD_ROW, CATEGORY_ROW] });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.gLMappingDeleteMany).toHaveBeenCalledWith({ where: { organizationId: "org-1" } });
    expect(mocks.gLMappingCreateMany).toHaveBeenCalledWith({
      data: [
        { organizationId: "org-1", paymentType: "Cash", categoryId: null, accountId: "acct-1000" },
        { organizationId: "org-1", paymentType: "Card", categoryId: null, accountId: "acct-1010" },
        { organizationId: "org-1", paymentType: null, categoryId: "cat-1", accountId: "acct-4000" },
      ],
    });
    expect(result).toEqual(LISTED);
  });

  it("an empty set clears all mappings (everything unmapped)", async () => {
    await replaceMappings("org-1", { mappings: [] });
    expect(mocks.gLMappingCreateMany).toHaveBeenCalledWith({ data: [] });
  });

  it("rejects a row with BOTH paymentType and categoryId", async () => {
    await expect(
      replaceMappings("org-1", { mappings: [{ ...CASH_ROW, categoryId: "cat-1" }] }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a row with NEITHER paymentType nor categoryId", async () => {
    await expect(
      replaceMappings("org-1", { mappings: [{ accountId: "acct-1000" }] }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys for the same payment type", async () => {
    await expect(
      replaceMappings("org-1", { mappings: [CASH_ROW, { ...CASH_ROW, accountId: "acct-1010" }] }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a category from another org", async () => {
    mocks.categoryFindMany.mockResolvedValue([]); // cat-1 unknown to org-1
    await expect(replaceMappings("org-1", { mappings: [CATEGORY_ROW] })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an account from another org", async () => {
    mocks.gLAccountFindMany.mockResolvedValue([{ id: "acct-1000", active: true }]); // acct-1010 unknown
    await expect(replaceMappings("org-1", { mappings: [CARD_ROW] })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an inactive account (auto-posting must not target closed accounts)", async () => {
    mocks.gLAccountFindMany.mockResolvedValue([{ id: "acct-1000", active: false }]);
    await expect(replaceMappings("org-1", { mappings: [CASH_ROW] })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("one bad row rejects the whole set — no partial state", async () => {
    mocks.gLAccountFindMany.mockResolvedValue([
      { id: "acct-1000", active: true },
      { id: "acct-4000", active: true },
    ]);
    await expect(
      replaceMappings("org-1", { mappings: [CASH_ROW, { ...CARD_ROW, accountId: "acct-missing" }] }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("surfaces errors with the row number so operators can find the bad entry", async () => {
    mocks.gLAccountFindMany.mockResolvedValue([]);
    const failure = await replaceMappings("org-1", { mappings: [CASH_ROW] }).catch((e) => e);
    expect(failure.message).toContain("Mapping 1");
  });
});

describe("listMappings", () => {
  it("lists org mappings with account and category names", async () => {
    const mappings = await listMappings("org-1");
    expect(mocks.gLMappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1" } }),
    );
    expect(mappings[0]).toMatchObject({ paymentType: "Cash", account: { code: "1000" } });
    expect(mappings[1]).toMatchObject({ category: { name: "Beverages" } });
  });
});
