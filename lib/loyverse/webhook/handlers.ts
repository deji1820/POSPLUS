/**
 * Webhook event dispatch (SPEC.md §9 webhook flow, issue #9 worker half).
 *
 * Maps a verified Loyverse webhook payload to single-record idempotent
 * upserts via the SAME per-record mapping the sync engine uses
 * (lib/loyverse/records.ts). Webhook types are `<resource>.<action>`
 * (e.g. "customers.update", "receipts.create"); the resource array rides in
 * the payload under the resource name (e.g. `customers: [{...}]`).
 *
 * Snapshot side effects (issue #16):
 * - `inventory_levels.*` — applied INLINE during dispatch: one ADJUSTMENT
 *   movement per level (delta = reported stock − current on-hand) via
 *   lib/inventory/projection.ts. This is the absolute-truth reconciliation
 *   path for stock changed outside POSPLUS. Receipt/refund inventory
 *   projection is NOT inline — the webhook processor enqueues
 *   `apply-inventory-for-*` jobs after the event is PROCESSED (§9 side
 *   effects), mirroring the finance-posting handoff.
 * - reorder / analytics triggers — land with the inventory issues.
 *
 * Receipt/refund finance-posting enqueue (#11) is NOT deferred: the dispatch
 * result carries the local receipt/refund ids and the webhook processor
 * enqueues `post-*-to-ledger` jobs after the event is marked PROCESSED.
 */
import { Prisma } from "@prisma/client";

import { applyInventoryLevelSnapshot } from "@/lib/inventory/projection";
import { UnrecoverableError } from "@/lib/queue/errors";
import {
  asString,
  linkCategoryParent,
  upsertCategoryRecord,
  upsertCustomerRecord,
  upsertEmployeeRecord,
  upsertItemRecord,
  upsertReceiptRecord,
  upsertStoreRecord,
} from "@/lib/loyverse/records";

export type WebhookDispatchStatus = "PROCESSED" | "IGNORED";

export interface WebhookDispatchResult {
  status: WebhookDispatchStatus;
  /** Resource that was processed (receipts, customers, ...). */
  resource: string;
  /** Records written (0 for IGNORED). */
  records: number;
  /** Refunds written when resource === "receipts". */
  refunds: number;
  /** Local receipt ids to post to the ledger (finance-posting enqueue, #11). */
  receiptIds: string[];
  /** Local refund ids to post as reversals (#11). */
  refundIds: string[];
  /** Why the event was ignored — surfaced in the audit note. */
  note?: string;
}

/**
 * Deferred resources remain documented follow-ups, recorded in the audit
 * note. `inventory_levels` left the set with #16 — it is handled inline
 * below.
 */
const DEFERRED_RESOURCES = new Set<string>();

/**
 * Resource prefix → single-record upsert. Returns records written, or null
 * when the record was rejected (missing id) and should be skipped.
 */
const RESOURCE_HANDLERS: Record<
  string,
  (orgId: string, record: Record<string, unknown>) => Promise<number>
> = {
  stores: async (orgId, record) => (await upsertStoreRecord(orgId, record)) ? 1 : 0,
  categories: async (orgId, record) => {
    if (!(await upsertCategoryRecord(orgId, record))) return 0;
    await linkCategoryParent(orgId, record);
    return 1;
  },
  items: async (orgId, record) => {
    if (asString(record.id) === null) return 0;
    await upsertItemRecord(orgId, record);
    return 1;
  },
  employees: async (orgId, record) => (await upsertEmployeeRecord(orgId, record)) ? 1 : 0,
  customers: async (orgId, record) => (await upsertCustomerRecord(orgId, record)) ? 1 : 0,
};

/** Extract the payload's resource array for a webhook type. */
function resourceRecords(
  payload: Record<string, unknown>,
  resource: string,
): Record<string, unknown>[] {
  const direct = payload[resource];
  if (Array.isArray(direct)) {
    return direct.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  // Fallback: exactly one array-of-objects value in the payload IS the batch.
  const arrays = Object.values(payload).filter(
    (value): value is Record<string, unknown>[] =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)),
  );
  return arrays.length === 1 ? arrays[0] : [];
}

/**
 * Dispatch one verified webhook event. Never throws for bad records — a
 * structurally invalid record is skipped (the sync will repair it); the
 * receipt "unknown-store" case is signalled via a thrown Error by the caller's
 * request: receipts REQUIRE the store FK, so a receipt whose store is unknown
 * locally is a FAILED event (it will not self-heal without the store).
 */
export async function dispatchWebhookEvent(input: {
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Stored event id — snapshot dedupe keys embed it so replays skip. */
  webhookEventId?: string;
}): Promise<WebhookDispatchResult> {
  const { organizationId, eventType, payload } = input;
  const resource = eventType.split(".")[0]?.trim().toLowerCase() ?? "";

  if (DEFERRED_RESOURCES.has(resource)) {
    return {
      status: "IGNORED",
      resource,
      records: 0,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
      note: `${resource} projection deferred to the inventory issues; event recorded but not applied.`,
    };
  }

  if (resource === "inventory_levels") {
    const records = resourceRecords(payload, "inventory_levels");
    let applied = 0;
    let skipped = 0;
    let unchanged = 0;
    const eventKey = input.webhookEventId ?? "unknown";
    for (const record of records) {
      const variantLoyverseId = asString(record.variant_id);
      const storeLoyverseId = asString(record.store_id);
      const inStockRaw = record.in_stock;
      if (!variantLoyverseId || !storeLoyverseId ||
          (typeof inStockRaw !== "number" && typeof inStockRaw !== "string")) {
        skipped += 1;
        continue; // structurally invalid level — the sync will repair it
      }
      const outcome = await applyInventoryLevelSnapshot(organizationId, {
        variantLoyverseId,
        storeLoyverseId,
        inStock: new Prisma.Decimal(inStockRaw),
        dedupeKey: `snapshot:${eventKey}:${variantLoyverseId}:${storeLoyverseId}`,
      });
      if (outcome.status === "applied" || outcome.status === "alreadyApplied") applied += 1;
      else if (outcome.status === "noChange") unchanged += 1;
      else skipped += 1;
    }
    return {
      status: "PROCESSED",
      resource,
      records: applied,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
      note: `inventory levels applied=${applied} unchanged=${unchanged} skipped=${skipped}`,
    };
  }

  if (resource === "receipts") {
    const records = resourceRecords(payload, "receipts");
    let written = 0;
    let refunds = 0;
    const receiptIds: string[] = [];
    const refundIds: string[] = [];
    for (const record of records) {
      const result = await upsertReceiptRecord(organizationId, record);
      if (!result.ok) {
        if (result.reason === "unknown-store") {
          throw new UnrecoverableError(
            `Receipt webhook references store ${String(record.store_id ?? "unknown")} which is not synced yet.`,
          );
        }
        continue; // missing id — nothing to key the upsert on
      }
      written += 1;
      refunds += result.refunds;
      receiptIds.push(result.receiptId);
      refundIds.push(...result.refundIds);
    }
    return { status: "PROCESSED", resource, records: written, refunds, receiptIds, refundIds };
  }

  const handler = RESOURCE_HANDLERS[resource];
  if (!handler) {
    return {
      status: "IGNORED",
      resource: resource || "unknown",
      records: 0,
      refunds: 0,
      receiptIds: [],
      refundIds: [],
      note: `Unsupported webhook type "${eventType}".`,
    };
  }

  const records = resourceRecords(payload, resource);
  let written = 0;
  for (const record of records) {
    written += await handler(organizationId, record);
  }
  return { status: "PROCESSED", resource, records: written, refunds: 0, receiptIds: [], refundIds: [] };
}
