/**
 * Journal read + reversal use-cases (SPEC.md §6 "/finance/ledger", §7 API
 * outline, §8 accounting invariants, issue #12).
 *
 * The ledger is append-only: reads are org-scoped, and the only write is a
 * reversal — a NEW POSTED entry mirroring the original's lines with
 * debit/credit swapped, linked via reversalOfId. Posted entries are never
 * mutated; a missing entry is a safe 404 (doubles as the cross-tenant guard).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getJournalEntry, listJournalEntries, reverseEntry } from "@/lib/finance/ledger";

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

const ENTRY_BASE = {
  id: "je-1",
  entryNumber: null,
  description: "Sale - receipt R-1",
  status: "POSTED",
  postedAt: new Date("2026-09-01T12:00:00Z"),
  store: { id: "store-1", name: "Main" },
  fiscalPeriod: null,
  reversalOfId: null,
  reversedBy: null,
};

/** A receipt posting: 1000 D 10 / 4000 C 10, plus a stray 0.00 line side. */
function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...ENTRY_BASE,
    sourceLink: {
      loyverseReceiptId: "lv-r1",
      loyverseRefundId: null,
      paymentType: "Cash",
      sourceTotal: "10.00",
      postedAt: new Date("2026-09-01T12:00:00Z"),
    },
    lines: [
      { debit: "10.00", credit: "0.00" },
      { debit: "0.00", credit: "10.00" },
    ],
    ...overrides,
  };
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

describe("listJournalEntries", () => {
  it("returns summaries with exact decimal totals and source typing", async () => {
    mocks.journalEntryFindMany.mockResolvedValue([
      makeEntry({
        id: "je-2",
        reversalOfId: "je-1",
        sourceLink: null,
        lines: [{ debit: "10.00", credit: "0.00" }, { debit: "0.00", credit: "10.00" }],
      }),
      makeEntry({
        id: "je-3",
        sourceLink: {
          loyverseReceiptId: "lv-r1",
          loyverseRefundId: "lv-rf1",
          paymentType: "Cash",
          sourceTotal: "10.00",
          postedAt: new Date("2026-09-01T12:00:01Z"),
        },
      }),
      makeEntry({ id: "je-4", sourceLink: null, lines: [] }),
    ]);
    const entries = await listJournalEntries("org-1", {});
    expect(entries.map((e) => [e.id, e.sourceType])).toEqual([
      ["je-2", "reversal"],
      ["je-3", "refund"],
      ["je-4", "manual"],
    ]);
    expect(entries[0]).toMatchObject({ totalDebit: "10.00", totalCredit: "10.00", lineCount: 2 });
    // je-4: entry with no lines still sums to 0.00 on both sides.
    expect(entries[2]).toMatchObject({ totalDebit: "0.00", totalCredit: "0.00" });
  });

  it("scopes to the org and maps every §6 filter into the where clause", async () => {
    mocks.journalEntryFindMany.mockResolvedValue([]);
    await listJournalEntries("org-1", {
      fiscalPeriodId: "fp-1",
      storeId: "store-1",
      accountId: "acct-9",
      source: "receipt",
    });
    const arg = mocks.journalEntryFindMany.mock.calls[0][0] as { where: { AND: Record<string, unknown>[] } };
    const and = arg.where.AND;
    expect(and[0]).toEqual({ organizationId: "org-1" });
    expect(and).toContainEqual({ fiscalPeriodId: "fp-1" });
    expect(and).toContainEqual({ storeId: "store-1" });
    expect(and).toContainEqual({ lines: { some: { accountId: "acct-9" } } });
    expect(and).toContainEqual({
      sourceLink: { is: { loyverseReceiptId: { not: null }, loyverseRefundId: null } },
    });
  });

  it("source filters: refund / reversal / manual", async () => {
    mocks.journalEntryFindMany.mockResolvedValue([]);
    for (const [source, expected] of [
      ["refund", { sourceLink: { is: { loyverseRefundId: { not: null } } } }],
      ["reversal", { reversalOfId: { not: null } }],
      ["manual", { AND: [{ sourceLink: { is: null } }, { reversalOfId: null }] }],
    ] as const) {
      await listJournalEntries("org-1", { source });
      const arg = mocks.journalEntryFindMany.mock.calls.at(-1)![0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(arg.where.AND).toContainEqual(expected);
    }
  });

  it("rejects unknown filter values with an operator-safe error", async () => {
    await expect(listJournalEntries("org-1", { source: "banana" })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });
});

describe("getJournalEntry", () => {
  it("returns the detail with account lines and the source link", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({
      ...makeEntry(),
      lines: [
        { id: "jl-1", accountId: "a-1000", debit: "10.00", credit: "0.00", memo: "Receipt payment (Cash)", account: { code: "1000", name: "Cash on Hand" } },
        { id: "jl-2", accountId: "a-4000", debit: "0.00", credit: "10.00", memo: "Sales - Sales Revenue", account: { code: "4000", name: "Sales Revenue" } },
      ],
    });
    const entry = await getJournalEntry("org-1", "je-1");
    expect(mocks.journalEntryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "je-1", organizationId: "org-1" } }),
    );
    expect(entry.sourceType).toBe("receipt");
    expect(entry.sourceLink).toMatchObject({ loyverseReceiptId: "lv-r1", paymentType: "Cash", sourceTotal: "10.00" });
    expect(entry.lines[0]).toEqual({
      id: "jl-1",
      accountId: "a-1000",
      accountCode: "1000",
      accountName: "Cash on Hand",
      debit: "10.00",
      credit: "0.00",
      memo: "Receipt payment (Cash)",
    });
    expect(entry.totalDebit).toBe("10.00");
  });

  it("404s safely when the entry is missing or belongs to another org", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue(null);
    await expect(getJournalEntry("org-1", "je-evil")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("reverseEntry", () => {
  const ORIGINAL = {
    id: "je-1",
    entryNumber: null,
    description: "Sale - receipt R-1",
    status: "POSTED",
    storeId: "store-1",
    fiscalPeriodId: "fp-9",
    reversalOfId: null,
    reversedBy: null,
    lines: [
      { accountId: "a-1000", debit: "10.00", credit: "0.00", memo: "Receipt payment (Cash)" },
      { accountId: "a-4000", debit: "0.00", credit: "10.00", memo: "Sales - Sales Revenue" },
    ],
  };

  beforeEach(() => {
    mocks.journalEntryFindFirst.mockResolvedValue(ORIGINAL);
    mocks.journalEntryCreate.mockResolvedValue({ id: "je-1-R" });
  });

  it("creates a linked mirror entry with debit/credit swapped, in one transaction", async () => {
    const result = await reverseEntry("org-1", "je-1", { reason: "Entered twice" }, "user-1");
    expect(result).toEqual({ reversalEntryId: "je-1-R" });
    expect(mocks.journalEntryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        storeId: "store-1",
        fiscalPeriodId: "fp-9",
        status: "POSTED",
        description: "Reversal of Sale - receipt R-1",
        reversalOfId: "je-1",
        createdById: "user-1",
        lines: {
          create: [
            { organizationId: "org-1", accountId: "a-1000", debit: "0.00", credit: "10.00", memo: "Reversal of: Receipt payment (Cash)" },
            { organizationId: "org-1", accountId: "a-4000", debit: "10.00", credit: "0.00", memo: "Reversal of: Sales - Sales Revenue" },
          ],
        },
      }),
    });
  });

  it("audits both sides: journal.reversed on the original, journal.posted on the new entry", async () => {
    await reverseEntry("org-1", "je-1", { reason: "oops" });
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "journal.reversed",
        entityType: "JournalEntry",
        entityId: "je-1",
        metadataJson: { reason: "oops", reversalEntryId: "je-1-R" },
      }),
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "journal.posted",
        entityId: "je-1-R",
        metadataJson: { source: "reversal", reversalOfId: "je-1", reason: "oops" },
      }),
    });
  });

  it("requires a non-empty reason", async () => {
    await expect(reverseEntry("org-1", "je-1", { reason: "  " })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
  });

  it("404s safely on a missing/cross-tenant entry", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue(null);
    await expect(reverseEntry("org-1", "nope", { reason: "x" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("refuses to reverse an entry that was already reversed", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({ ...ORIGINAL, reversedBy: { id: "je-1-R" } });
    await expect(reverseEntry("org-1", "je-1", { reason: "x" })).rejects.toMatchObject({
      status: 400,
      code: "ALREADY_REVERSED",
    });
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
  });

  it("refuses to reverse a reversal entry itself", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({ ...ORIGINAL, reversalOfId: "je-0" });
    await expect(reverseEntry("org-1", "je-1", { reason: "x" })).rejects.toMatchObject({
      status: 400,
      code: "IS_REVERSAL",
    });
  });

  it("refuses to reverse an entry that is not POSTED", async () => {
    mocks.journalEntryFindFirst.mockResolvedValue({ ...ORIGINAL, status: "DRAFT" });
    await expect(reverseEntry("org-1", "je-1", { reason: "x" })).rejects.toMatchObject({
      status: 400,
      code: "ENTRY_NOT_POSTED",
    });
  });

  it("a raced duplicate insert (P2002 on reversalOfId) reports ALREADY_REVERSED", async () => {
    mocks.journalEntryCreate.mockRejectedValue({ code: "P2002" });
    await expect(reverseEntry("org-1", "je-1", { reason: "x" })).rejects.toMatchObject({
      status: 400,
      code: "ALREADY_REVERSED",
    });
  });

  it("rethrows unexpected errors untouched", async () => {
    mocks.journalEntryCreate.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(reverseEntry("org-1", "je-1", { reason: "x" })).rejects.toBeInstanceOf(Error);
  });
});
