/**
 * Job-name → processor registry (SPEC.md §10).
 *
 * `initial-loyverse-sync` / `incremental-loyverse-sync` (#6/#7),
 * `process-loyverse-webhook` (#9), `post-receipt-to-ledger` /
 * `post-refund-to-ledger` (#11), the inventory projection / stock
 * write-back jobs (#16), the three document renders
 * `generate-po-pdf` / `generate-payslip-pdf` / `generate-pnl-pdf` (#32),
 * and the nightly maintenance jobs (#33) `recalculate-reorder-points` /
 * `stale-webhook-sync-check` / `reconciliation-check` have real processors;
 * every other SPEC §10 job type routes to a permanent
 * not-implemented stub that dead-letters immediately with an operator-safe
 * reason recorded in the failed set (§19). Domain issues register their
 * processors here as they land.
 */
import { UnrecoverableError, type Job } from "bullmq";

import {
  processPostReceiptToLedgerJob,
  processPostRefundToLedgerJob,
} from "@/worker/processors/finance-posting";
import { processGenerateDocumentJob } from "@/worker/processors/documents";
import {
  processApplyInventoryJob,
  processStockWritebackJob,
} from "@/worker/processors/inventory";
import { processLoyverseSyncJob } from "@/worker/processors/loyverse-sync";
import { processLoyverseWebhookJob } from "@/worker/processors/loyverse-webhook";
import {
  processReconciliationCheckJob,
  processRecalculateReorderPointsJob,
  processStaleWebhookSyncCheckJob,
} from "@/worker/processors/maintenance";

export type Processor = (job: Job) => Promise<unknown>;

const registry = new Map<string, Processor>([
  ["initial-loyverse-sync", processLoyverseSyncJob as Processor],
  ["incremental-loyverse-sync", processLoyverseSyncJob as Processor],
  ["process-loyverse-webhook", processLoyverseWebhookJob as Processor],
  ["post-receipt-to-ledger", processPostReceiptToLedgerJob as Processor],
  ["post-refund-to-ledger", processPostRefundToLedgerJob as Processor],
  ["generate-po-pdf", processGenerateDocumentJob as Processor],
  ["generate-payslip-pdf", processGenerateDocumentJob as Processor],
  ["generate-pnl-pdf", processGenerateDocumentJob as Processor],
  ["apply-inventory-for-receipt", processApplyInventoryJob as Processor],
  ["apply-inventory-for-refund", processApplyInventoryJob as Processor],
  ["write-back-stock", processStockWritebackJob as Processor],
  ["recalculate-reorder-points", processRecalculateReorderPointsJob as Processor],
  ["stale-webhook-sync-check", processStaleWebhookSyncCheckJob as Processor],
  ["reconciliation-check", processReconciliationCheckJob as Processor],
]);

export function registerProcessor(jobName: string, processor: Processor): void {
  registry.set(jobName, processor);
}

export function resolveProcessor(jobName: string): Processor {
  const registered = registry.get(jobName);
  if (registered) return registered;
  return () =>
    Promise.reject(
      new UnrecoverableError(`Job "${jobName}" is not implemented yet.`),
    );
}
