/**
 * Auto-posting to the ledger (SPEC.md §8 invariants + §11 finance rules,
 * issue #11). Every posted entry is balanced in exact decimal arithmetic,
 * carries a LedgerSourceLink back to the Loyverse source, commits entry +
 * link + audit in ONE transaction, and is idempotent (re-posting the same
 * receipt/refund is a no-op, including the concurrent P2002 race).
 *
 * Configuration gaps surface as operator-safe FinanceError codes:
 * PAYMENT_TYPE_UNMAPPED, ACCOUNT_INACTIVE, MISSING_DEFAULT_ACCOUNT,
 * INVALID_SOURCE, NOT_FOUND.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FinanceError } from "@/lib/finance/errors";
import { postReceiptToLedger, postRefundToLedger } from "@/lib/finance/posting";

const mocks = vi.hoisted(() => ({
  receiptFindFirst: vi.fn(),
  refundFindFirst: vi.fn(),
  ledgerSourceLinkFindFirst: vi.fn(),
  ledgerSourceLinkCreate: vi.fn(),
  gLMappingFindMany: vi.fn(),
  gLAccountFindFirst: vi.fn(),
  variantFindMany: vi.fn(),
  journalEntryCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    receipt: { findFirst: mocks.receiptFindFirst },
    refund: { findFirst: mocks.refundFindFirst },
    ledgerSourceLink: {
      findFirst: mocks.ledgerSourceLinkFindFirst,
      create: mocks.ledgerSourceLinkCreate,
    },
    gLMapping: { findMany: mocks.gLMappingFindMany },
    gLAccount: { findFirst: mocks.gLAccountFindFirst },
    variant: { findMany: mocks.variantFindMany },
    journalEntry: { create: mocks.journalEntryCreate },
    auditLog: { create: mocks.auditLogCreate },
    $transaction: mocks.$transaction,
  },
}));

const RECEIPT = {
  id: "rec-1",
  organizationId: "org-1",
  loyverseId: "lv-rec-1",
  storeId: "store-1",
  receiptNumber: "R-1",
  paymentType: "Cash",
  total: "10.00",
  lines: [
    { variantId: "v-1", total: "6.00" },
    { variantId: "v-2", total: "4.00" },
  ],
};

const MAPPINGS = [
  { paymentType: "Cash", categoryId: null, account: { id: "acct-1000", name: "Cash on Hand", active: true } },
  { paymentType: null, categoryId: "cat-1", account: { id: "acct-4100", name: "Beverages Revenue", active: true } },
];

const DEFAULT_REVENUE = { id: "acct-4000", name: "Sales Revenue", active: true };

function setupHappyPath(): void {
  mocks.receiptFindFirst.mockResolvedValue(RECEIPT);
  // No existing posting for this receipt yet.
  mocks.ledgerSourceLinkFindFirst.mockResolvedValue(null);
  mocks.gLMappingFindMany.mockResolvedValue(MAPPINGS);
  mocks.gLAccountFindFirst.mockResolvedValue(DEFAULT_REVENUE);
  // v-1 sells a categorized item, v-2 an uncategorized one.
  mocks.variantFindMany.mockResolvedValue([
    { id: "v-1", item: { categoryId: "cat-1" } },
    { id: "v-2", item: { categoryId: null } },
  ]);
  mocks.journalEntryCreate.mockResolvedValue({ id: "je-1" });
  mocks.ledgerSourceLinkCreate.mockResolvedValue({ id: "link-1" });
  mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" });
  mocks.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      journalEntry: { create: mocks.journalEntryCreate },
      ledgerSourceLink: { create: mocks.ledgerSourceLinkCreate },
      auditLog: { create: mocks.auditLogCreate },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
});

describe("postReceiptToLedger", () => {
  it("posts a balanced entry: debit mapped payment account, credit category/default revenue", async () => {
    const result = await postReceiptToLedger("org-1", "rec-1");

    expect(result).toEqual({ posted: true, journalEntryId: "je-1" });
    expect(mocks.receiptFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rec-1", organizationId: "org-1" } }),
    );
    const entry = mocks.journalEntryCreate.mock.calls[0][0].data;
    expect(entry).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        storeId: "store-1",
        status: "POSTED",
        description: "Sale - receipt R-1",
      }),
    );
    expect(entry.lines.create).toEqual([
      { organizationId: "org-1", accountId: "acct-1000", debit: "10.00", credit: "0", memo: "Receipt payment (Cash)" },
      { organizationId: "org-1", accountId: "acct-4100", debit: "0", credit: "6.00", memo: "Sales - Beverages Revenue" },
      { organizationId: "org-1", accountId: "acct-4000", debit: "0", credit: "4.00", memo: "Sales - Sales Revenue" },
    ]);
    // Debits == credits exactly (10.00 both sides).
    const debits = entry.lines.create
      .filter((l: { debit: string }) => l.debit !== "0")
      .reduce((s: number, l: { debit: string }) => s + Number(l.debit), 0);
    const credits = entry.lines.create
      .filter((l: { credit: string }) => l.credit !== "0")
      .reduce((s: number, l: { credit: string }) => s + Number(l.credit), 0);
    expect(debits).toBe(credits);
  });

  it("writes the LedgerSourceLink the §11 linkage requires", async () => {
    await postReceiptToLedger("org-1", "rec-1");
    expect(mocks.ledgerSourceLinkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        journalEntryId: "je-1",
        organizationId: "org-1",
        storeId: "store-1",
        loyverseReceiptId: "lv-rec-1",
        loyverseRefundId: null,
        paymentType: "Cash",
        sourceTotal: "10.00",
      }),
    });
  });

  it("writes one journal.posted audit row with sanitized metadata", async () => {
    await postReceiptToLedger("org-1", "rec-1");
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        action: "journal.posted",
        entityType: "JournalEntry",
        entityId: "je-1",
        metadataJson: {
          source: "receipt",
          loyverseReceiptId: "lv-rec-1",
          loyverseRefundId: null,
          paymentType: "Cash",
          total: "10.00",
        },
      }),
    });
  });

  it("is idempotent: an existing source link turns the call into a no-op", async () => {
    mocks.ledgerSourceLinkFindFirst.mockResolvedValue({ journalEntryId: "je-existing" });
    const result = await postReceiptToLedger("org-1", "rec-1");
    expect(result).toEqual({ posted: false, journalEntryId: "je-existing" });
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
  });

  it("treats a concurrent duplicate insert (P2002 on the source link) as already posted", async () => {
    mocks.ledgerSourceLinkCreate.mockRejectedValue({ code: "P2002" });
    mocks.ledgerSourceLinkFindFirst
      .mockResolvedValueOnce(null) // pre-check: not posted yet
      .mockResolvedValueOnce({ journalEntryId: "je-race" }); // raced insert won

    const result = await postReceiptToLedger("org-1", "rec-1");
    expect(result).toEqual({ posted: false, journalEntryId: "je-race" });
  });

  it("rejects an unmapped payment type with an operator-safe error", async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...RECEIPT, paymentType: "Crypto" });
    await expect(postReceiptToLedger("org-1", "rec-1")).rejects.toMatchObject({
      status: 400,
      code: "PAYMENT_TYPE_UNMAPPED",
    });
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
  });

  it("the unmapped-payment error names the payment type and the fix location", async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...RECEIPT, paymentType: "Crypto" });
    const error = await postReceiptToLedger("org-1", "rec-1").catch((e) => e);
    expect(error).toBeInstanceOf(FinanceError);
    expect(error.message).toContain('"Crypto"');
    expect(error.message).toContain("GL Mappings");
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
  });

  it("rejects when the mapped payment account was deactivated after mapping", async () => {
    mocks.gLMappingFindMany.mockResolvedValue([
      { paymentType: "Cash", categoryId: null, account: { id: "acct-1000", name: "Cash on Hand", active: false } },
    ]);
    await expect(postReceiptToLedger("org-1", "rec-1")).rejects.toMatchObject({
      status: 400,
      code: "ACCOUNT_INACTIVE",
    });
  });

  it("rejects when the default revenue account (4000) is missing", async () => {
    mocks.gLAccountFindFirst.mockResolvedValue(null);
    await expect(postReceiptToLedger("org-1", "rec-1")).rejects.toMatchObject({
      status: 500,
      code: "MISSING_DEFAULT_ACCOUNT",
    });
  });

  it("trues up a line-total/receipt-total mismatch so the entry still balances", async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...RECEIPT, total: "10.00", lines: [{ variantId: "v-2", total: "9.50" }] });
    await postReceiptToLedger("org-1", "rec-1");
    const lines = mocks.journalEntryCreate.mock.calls[0][0].data.lines.create;
    // 9.50 credit + 0.50 adjustment credit == 10.00 debit.
    expect(lines).toContainEqual(
      expect.objectContaining({ accountId: "acct-4000", credit: "0.50", memo: "Receipt total adjustment" }),
    );
  });

  it("refuses to post a negative receipt total", async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...RECEIPT, total: "-1.00" });
    await expect(postReceiptToLedger("org-1", "rec-1")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_SOURCE",
    });
  });

  it("404s (safe) when the receipt is missing or belongs to another org", async () => {
    mocks.receiptFindFirst.mockResolvedValue(null);
    await expect(postReceiptToLedger("org-1", "rec-missing")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("postRefundToLedger", () => {
  const REFUND = {
    id: "ref-1",
    organizationId: "org-1",
    loyverseId: "lv-ref-1",
    total: "10.00",
    lines: [{ variantId: "v-1", total: "10.00" }],
    receipt: {
      id: "rec-1",
      loyverseId: "lv-rec-1",
      storeId: "store-1",
      receiptNumber: "R-1",
      paymentType: "Cash",
    },
  };

  beforeEach(() => {
    mocks.refundFindFirst.mockResolvedValue(REFUND);
  });

  it("posts the mirror entry: debit revenue, credit the payment account", async () => {
    const result = await postRefundToLedger("org-1", "ref-1");

    expect(result).toEqual({ posted: true, journalEntryId: "je-1" });
    const entry = mocks.journalEntryCreate.mock.calls[0][0].data;
    expect(entry.description).toBe("Refund - receipt R-1");
    expect(entry.lines.create).toEqual([
      { organizationId: "org-1", accountId: "acct-4100", debit: "10.00", credit: "0", memo: "Refund - Beverages Revenue" },
      { organizationId: "org-1", accountId: "acct-1000", debit: "0", credit: "10.00", memo: "Refund payment (Cash)" },
    ]);
  });

  it("links the refund entry to the parent receipt source AND the refund id", async () => {
    await postRefundToLedger("org-1", "ref-1");
    expect(mocks.ledgerSourceLinkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        loyverseReceiptId: "lv-rec-1",
        loyverseRefundId: "lv-ref-1",
        paymentType: "Cash",
        sourceTotal: "10.00",
      }),
    });
  });

  it("is idempotent per refund (existing refund link = no-op)", async () => {
    mocks.ledgerSourceLinkFindFirst.mockResolvedValue({ journalEntryId: "je-existing" });
    const result = await postRefundToLedger("org-1", "ref-1");
    expect(result).toEqual({ posted: false, journalEntryId: "je-existing" });
    expect(mocks.journalEntryCreate).not.toHaveBeenCalled();
  });

  it("reuses the parent receipt's payment mapping (refunds carry no payment type of their own)", async () => {
    mocks.refundFindFirst.mockResolvedValue({
      ...REFUND,
      receipt: { ...REFUND.receipt, paymentType: null },
    });
    await expect(postRefundToLedger("org-1", "ref-1")).rejects.toMatchObject({
      code: "PAYMENT_TYPE_UNMAPPED",
    });
  });

  it("audits the refund posting as its own journal entry (original untouched)", async () => {
    await postRefundToLedger("org-1", "ref-1");
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "journal.posted",
        metadataJson: expect.objectContaining({ source: "refund", loyverseRefundId: "lv-ref-1" }),
      }),
    });
  });

  it("404s (safe) when the refund is missing or belongs to another org", async () => {
    mocks.refundFindFirst.mockResolvedValue(null);
    await expect(postRefundToLedger("org-1", "ref-missing")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});
