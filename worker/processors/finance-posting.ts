/**
 * Finance-posting processors for the `finance-posting` queue (SPEC.md §10
 * `post-receipt-to-ledger` / `post-refund-to-ledger`, issue #11).
 *
 * Thin wrappers around the posting use-cases (lib/finance/posting.ts): the
 * org-scoped lookup there doubles as the cross-tenant guard (a receipt id from
 * another org resolves to NOT_FOUND, never to a foreign posting). Error
 * taxonomy (§19):
 *
 * - FinanceError — expected permanent conditions (source missing, unmapped
 *   payment type, inactive/missing account, generated unbalanced entry):
 *   recorded via jobLog and dead-lettered with the safe message via
 *   UnrecoverableError so they don't burn 5 retries on a config gap the
 *   operator must fix first.
 * - already-posted idempotent no-op: logged and completed normally.
 * - anything unexpected: rethrown so BullMQ retries with backoff.
 */
import type { Job } from "bullmq";

import { FinanceError } from "@/lib/finance/errors";
import { postReceiptToLedger, postRefundToLedger } from "@/lib/finance/posting";
import type { PostReceiptJobData, PostRefundJobData } from "@/lib/queue/enqueue";
import { UnrecoverableError } from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

export async function processPostReceiptToLedgerJob(
  job: Job<PostReceiptJobData>,
): Promise<void> {
  const { receiptId, organizationId } = job.data;
  const logId = job.id ?? `post-receipt-${receiptId}`;
  try {
    const result = await postReceiptToLedger(organizationId, receiptId);
    jobLog(logId, result.posted ? "journal posted" : "journal posting skipped (already posted)", {
      receiptId,
      journalEntryId: result.journalEntryId,
    });
  } catch (error) {
    if (error instanceof FinanceError) {
      jobLog(logId, "journal posting failed", { receiptId, error: error.message });
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}

export async function processPostRefundToLedgerJob(
  job: Job<PostRefundJobData>,
): Promise<void> {
  const { refundId, organizationId } = job.data;
  const logId = job.id ?? `post-refund-${refundId}`;
  try {
    const result = await postRefundToLedger(organizationId, refundId);
    jobLog(logId, result.posted ? "journal posted" : "journal posting skipped (already posted)", {
      refundId,
      journalEntryId: result.journalEntryId,
    });
  } catch (error) {
    if (error instanceof FinanceError) {
      jobLog(logId, "journal posting failed", { refundId, error: error.message });
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}
