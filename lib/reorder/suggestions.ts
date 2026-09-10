/**
 * Reorder suggestion workflow (SPEC.md §12, issue #17).
 *
 * The nightly job (issue #33) recalculates reorder points and upserts
 * PENDING ReorderSuggestion rows; this module is the workflow layer on top:
 *
 *   - `listPendingSuggestions` — the /supply-chain/reorder list, with the
 *     §12 inputs behind every suggestion parsed out of `reason` so managers
 *     can see exactly why it was suggested;
 *   - `acceptSuggestion` — turns one PENDING suggestion into a Draft
 *     PurchaseOrder (§13 workflow starts at DRAFT) and marks it ACCEPTED;
 *   - `dismissSuggestion` — marks one PENDING suggestion DISMISSED.
 *
 * Every mutation is org-scoped (tenant isolation) and treats "not found /
 * already handled" as a domain error rather than a silent no-op — the UI
 * can say so. The business writes run in one transaction; the audit row is
 * written immediately after commit (see acceptSuggestion for why in-tx
 * audit is unsafe with a never-throws writer).
 */
import { Prisma } from "@prisma/client";

import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { prisma } from "@/lib/db";
import {
  ReorderSuggestionNotFoundError,
  ReorderSupplierNotFoundError,
} from "@/lib/reorder/errors";

/** Inputs the nightly job stored in `reason` (§12 "UI must show the inputs"). */
export interface SuggestionInputs {
  lookbackDays: number;
  averageDailySales: string;
  leadTimeDays: number;
  safetyStockDays: number;
  reorderPoint: string;
  targetStock: string;
  onHand: string;
  onOrder: string;
  computedAt: string | null;
}

/** One row of the /supply-chain/reorder list (all values serialized). */
export interface PendingSuggestion {
  id: string;
  itemName: string;
  variantName: string;
  variantSku: string | null;
  warehouseName: string;
  suggestedQty: string;
  averageDailySales: string;
  reorderPoint: string;
  createdAt: string;
  /** §12 inputs behind the suggestion; null when the job wrote no reason. */
  inputs: SuggestionInputs | null;
}

/**
 * Parse the `reason` JSON the nightly job stored. Defensive: a suggestion
 * from an older job (or a hand-inserted row) may lack fields, in which case
 * the row's own typed columns still carry the velocity inputs.
 */
function parseReason(reason: Prisma.JsonValue | null): SuggestionInputs | null {
  if (reason === null || typeof reason !== "object" || Array.isArray(reason)) {
    return null;
  }
  const record = reason as Record<string, unknown>;
  return {
    lookbackDays: typeof record.lookbackDays === "number" ? record.lookbackDays : 0,
    averageDailySales: String(record.averageDailySales ?? ""),
    leadTimeDays: typeof record.leadTimeDays === "number" ? record.leadTimeDays : 0,
    safetyStockDays: typeof record.safetyStockDays === "number" ? record.safetyStockDays : 0,
    reorderPoint: String(record.reorderPoint ?? ""),
    targetStock: String(record.targetStock ?? ""),
    onHand: String(record.onHand ?? ""),
    onOrder: String(record.onOrder ?? ""),
    computedAt: typeof record.computedAt === "string" ? record.computedAt : null,
  };
}

/** PENDING suggestions for the org, oldest first, with display names joined. */
export async function listPendingSuggestions(
  orgId: string,
): Promise<PendingSuggestion[]> {
  const rows = await prisma.reorderSuggestion.findMany({
    where: { organizationId: orgId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      variant: {
        select: { name: true, sku: true, item: { select: { name: true } } },
      },
      warehouse: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    itemName: row.variant.item.name,
    variantName: row.variant.name,
    variantSku: row.variant.sku,
    warehouseName: row.warehouse.name,
    suggestedQty: row.suggestedQty.toString(),
    averageDailySales: row.averageDailySales.toString(),
    reorderPoint: row.reorderPoint.toString(),
    createdAt: row.createdAt.toISOString(),
    inputs: parseReason(row.reason),
  }));
}

/**
 * PO numbers are per-organization `PO-YYYYMMDD-NNN`. Nothing else in the
 * codebase numbers POs yet (§13 defers to issues), so this establishes the
 * convention; the unique([organizationId, number]) constraint plus a retry
 * on P2002 keeps concurrent accepts from colliding.
 */
function poNumberFor(date: Date, sequence: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `PO-${y}${m}${d}-${String(sequence).padStart(3, "0")}`;
}

export interface AcceptSuggestionResult {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
}

const MAX_PO_NUMBER_ATTEMPTS = 5;

/**
 * Accept one PENDING suggestion: create a Draft PurchaseOrder for the chosen
 * supplier with a single line (suggested quantity at the variant's default
 * cost), mark the suggestion ACCEPTED, and audit the decision — atomically.
 * The PO stays DRAFT; submitting it into the approval flow is §13/#18.
 */
export async function acceptSuggestion(
  orgId: string,
  actorUserId: string,
  input: { suggestionId: string; supplierId: string },
): Promise<AcceptSuggestionResult> {
  const suggestion = await prisma.reorderSuggestion.findFirst({
    where: { id: input.suggestionId, organizationId: orgId, status: "PENDING" },
    include: { variant: { select: { defaultCost: true } } },
  });
  if (!suggestion) throw new ReorderSuggestionNotFoundError();

  const supplier = await prisma.supplier.findFirst({
    where: { id: input.supplierId, organizationId: orgId, active: true },
    select: { id: true },
  });
  if (!supplier) throw new ReorderSupplierNotFoundError();

  const quantity = new Prisma.Decimal(suggestion.suggestedQty);
  const unitPrice = new Prisma.Decimal(suggestion.variant.defaultCost ?? 0);
  const lineTotal = quantity.mul(unitPrice);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_PO_NUMBER_ATTEMPTS; attempt += 1) {
    const number = poNumberFor(new Date(), attempt);
    try {
      const po = await prisma.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: {
            organizationId: orgId,
            number,
            supplierId: supplier.id,
            destinationWarehouseId: suggestion.warehouseId,
            status: "DRAFT",
            subtotal: lineTotal,
            total: lineTotal,
            createdById: actorUserId,
          },
          select: { id: true, number: true },
        });
        await tx.purchaseOrderLine.create({
          data: {
            organizationId: orgId,
            purchaseOrderId: created.id,
            variantId: suggestion.variantId,
            quantity,
            unitPrice,
          },
        });
        await tx.reorderSuggestion.update({
          where: { id: suggestion.id },
          data: { status: "ACCEPTED" },
        });
        return created;
      });
      // Audit AFTER commit, not inside the transaction: writeAudit never
      // throws, and a swallowed statement failure inside a Prisma sequential
      // transaction aborts the whole tx (verified E2E) — an audit hiccup
      // must not invisibly discard the PO. Best-effort per the writer.
      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: AUDIT_ACTIONS.REORDER.SUGGESTION_ACCEPTED,
        entityType: "ReorderSuggestion",
        entityId: suggestion.id,
        afterJson: {
          status: "ACCEPTED",
          purchaseOrderId: po.id,
          purchaseOrderNumber: po.number,
          supplierId: supplier.id,
          quantity: quantity.toString(),
          unitPrice: unitPrice.toString(),
        },
      });
      return { purchaseOrderId: po.id, purchaseOrderNumber: po.number };
    } catch (error) {
      // Number collision with a concurrent accept: retry with the next
      // sequence. Anything else (including a lost race on the suggestion
      // itself) is a real failure.
      if (isUniqueViolation(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PO number allocation failed.");
}

/** Dismiss one PENDING suggestion. Already-handled rows are a domain error. */
export async function dismissSuggestion(
  orgId: string,
  actorUserId: string,
  suggestionId: string,
): Promise<void> {
  // Single statement — atomic without a transaction.
  const updated = await prisma.reorderSuggestion.updateMany({
    where: { id: suggestionId, organizationId: orgId, status: "PENDING" },
    data: { status: "DISMISSED" },
  });
  if (updated.count === 0) throw new ReorderSuggestionNotFoundError();
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: AUDIT_ACTIONS.REORDER.SUGGESTION_DISMISSED,
    entityType: "ReorderSuggestion",
    entityId: suggestionId,
    afterJson: { status: "DISMISSED" },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
