-- JournalEntry.storeId gains a real FK (ON DELETE SET NULL) so ledger reads
-- can include the store. Existing values reference org-owned stores already
-- (receipt postings copy the receipt's storeId); NULL stays NULL.
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
