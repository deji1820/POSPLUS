-- Ledger source links: refunds post their own journal entries (#11), so the
-- link needs the Loyverse refund id for traceability AND idempotency (a refund
-- link shares loyverseReceiptId with its parent receipt's link).
--
-- Partial unique indexes enforce the accounting-side idempotency invariant
-- structurally: at most ONE journal entry per Loyverse receipt (links with no
-- refund id) and per Loyverse refund (links with a refund id). A racing
-- duplicate insert fails instead of double-posting.

ALTER TABLE "LedgerSourceLink" ADD COLUMN "loyverseRefundId" TEXT;

CREATE INDEX "LedgerSourceLink_organizationId_loyverseRefundId_idx"
  ON "LedgerSourceLink"("organizationId", "loyverseRefundId");

CREATE UNIQUE INDEX "LedgerSourceLink_one_entry_per_receipt_key"
  ON "LedgerSourceLink"("organizationId", "loyverseReceiptId")
  WHERE "loyverseRefundId" IS NULL;

CREATE UNIQUE INDEX "LedgerSourceLink_one_entry_per_refund_key"
  ON "LedgerSourceLink"("organizationId", "loyverseRefundId")
  WHERE "loyverseRefundId" IS NOT NULL;
