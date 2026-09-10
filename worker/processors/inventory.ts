/**
 * Inventory queue processors (SPEC.md §10, issue #16).
 *
 * `apply-inventory-for-receipt` / `apply-inventory-for-refund` project one
 * webhook receipt/refund into the immutable movement ledger + balance
 * projection (lib/inventory/projection.ts). The projection itself is
 * idempotent per line, so a BullMQ retry is a no-op; the only expected
 * permanent failure is a store with no linked warehouse — a configuration
 * gap the operator must fix, so it dead-letters with an operator-safe
 * message instead of burning retries (§19).
 *
 * `write-back-stock` delivers one StockWritebackRequest to Loyverse
 * (absolute stock_after semantics) and records the sanitized request /
 * response metadata on the row — never the API key (§24).
 */
import type { Job } from "bullmq";

import { InventoryError } from "@/lib/inventory/errors";
import {
  applyReceiptSale,
  applyRefundReturn,
} from "@/lib/inventory/projection";
import {
  performStockWriteback,
} from "@/lib/loyverse/stock-writeback";
import type { ApplyInventoryJobData, StockWritebackJobData } from "@/lib/queue/enqueue";
import {
  safeJobErrorMessage,
  UnrecoverableError,
} from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

export async function processApplyInventoryJob(
  job: Job<ApplyInventoryJobData>,
): Promise<void> {
  const { kind, sourceId, organizationId } = job.data;
  const logId = job.id ?? `inv-${kind}-${sourceId}`;

  try {
    const result = kind === "receipt"
      ? await applyReceiptSale(organizationId, sourceId)
      : await applyRefundReturn(organizationId, sourceId);
    jobLog(logId, "inventory projection applied", {
      kind,
      sourceId,
      movements: result.movements,
      alreadyApplied: result.alreadyApplied,
    });
  } catch (error) {
    if (error instanceof InventoryError) {
      // Operator configuration gap (e.g. WAREHOUSE_NOT_MAPPED) — retrying
      // cannot fix it; dead-letter with the safe message for the operator.
      jobLog(logId, "inventory projection failed", { kind, sourceId, error: error.message });
      throw new UnrecoverableError(error.message);
    }
    const safe = safeJobErrorMessage(error);
    jobLog(logId, "inventory projection failed", { kind, sourceId, error: safe });
    throw error;
  }
}

export async function processStockWritebackJob(
  job: Job<StockWritebackJobData>,
): Promise<void> {
  const { stockWritebackRequestId, organizationId } = job.data;
  const logId = job.id ?? `writeback-${stockWritebackRequestId}`;

  try {
    const result = await performStockWriteback(stockWritebackRequestId, organizationId);
    jobLog(logId, "stock write-back delivered", {
      stockWritebackRequestId,
      status: result.status,
    });
  } catch (error) {
    if (error instanceof InventoryError) {
      jobLog(logId, "stock write-back failed", { stockWritebackRequestId, error: error.message });
      throw new UnrecoverableError(error.message);
    }
    const safe = safeJobErrorMessage(error);
    jobLog(logId, "stock write-back failed", { stockWritebackRequestId, error: safe });
    throw error;
  }
}
