-- Issue #16: inventory projection idempotency + outbound stock write-back log.
--
-- 1. InventoryMovement.dedupeKey: one movement per source line / snapshot,
--    unique per organization. A retried webhook dispatch or job re-run that
--    hits the key has already committed its balance change and skips.
--    Nullable so movements without a natural key (manual adjustments added
--    by later issues) are still allowed; the partial unique index enforces
--    uniqueness only where the key is present.
-- 2. StockWritebackRequest: sanitized record of every outbound Loyverse
--    stock write-back (ids + quantity + response metadata — never secrets).

ALTER TABLE "InventoryMovement" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "InventoryMovement_organizationId_dedupeKey_key"
  ON "InventoryMovement"("organizationId", "dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;

CREATE TABLE "StockWritebackRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "storeId" TEXT,
  "quantity" DECIMAL(14,3) NOT NULL,
  "reason" TEXT NOT NULL,
  "referenceType" TEXT,
  "referenceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requestPayload" JSONB,
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "StockWritebackRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "StockWritebackRequest_organizationId_createdAt_idx"
  ON "StockWritebackRequest"("organizationId", "createdAt");
