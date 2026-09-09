-- Loyverse business id captured at connect time (#9): webhook payloads carry
-- merchant_id, and routing an event to its organization requires this mapping
-- (SPEC.md §9 webhook flow, §18 "never trust tenant identifiers from an
-- unauthenticated body" — the signature authenticates, merchantId attributes).
ALTER TABLE "LoyverseConnection" ADD COLUMN "merchantId" TEXT;
CREATE INDEX "LoyverseConnection_merchantId_idx" ON "LoyverseConnection"("merchantId");
