/**
 * Inventory projection (SPEC.md §8, issue #16).
 *
 * The projection rule: InventoryBalance rows are ONLY ever written as the
 * sum of immutable InventoryMovement rows — every balance change traces to
 * ≥1 movement (issue acceptance). Balances are an upsert-on-increment
 * projection, never a mutable counter edited in place.
 *
 * Sources wired in this issue:
 *   - Loyverse receipt  → SALE movement (negative delta per line), applied
 *     by a worker job after the webhook processor marks the event PROCESSED
 *     (mirrors the finance-posting handoff, SPEC.md §9).
 *   - Loyverse refund   → REFUND movement (positive delta per line), same path.
 *   - Loyverse `inventory_levels.update` webhook → ADJUSTMENT snapshot
 *     movement (delta = reported stock − current on-hand), applied inline
 *     during dispatch — it is the absolute-truth reconciliation path for
 *     stock changed outside POSPLUS (counts in the Loyverse UI, other apps).
 *
 * Idempotency: every movement carries a per-org unique `dedupeKey` (partial
 * unique index). A retried dispatch or job re-run whose movement already
 * exists skips it — the balance change committed in the same transaction as
 * the movement, so the pair is never half-applied. Later producers
 * (transfers, production, PO receiving) reuse `applyMovement`.
 *
 * Warehouse attribution: a receipt/snapshot resolves to the warehouse
 * linked to its store (Warehouse.storeId). A store with no warehouse is a
 * permanent configuration gap — the job dead-letters with an
 * operator-safe message rather than silently dropping stock.
 */
import { Prisma, type InventoryMovementType } from "@prisma/client";

import { prisma } from "@/lib/db";
import { InventoryError } from "@/lib/inventory/errors";

const Decimal = Prisma.Decimal;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** The store-linked warehouse that holds a store's stock, or null. */
export async function resolveWarehouseId(orgId: string, storeId: string): Promise<string | null> {
  const warehouse = await prisma.warehouse.findFirst({
    where: { organizationId: orgId, storeId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return warehouse?.id ?? null;
}

export interface ApplyMovementInput {
  organizationId: string;
  warehouseId: string;
  variantId: string;
  /** Positive = stock in, negative = stock out. */
  quantityDelta: Prisma.Decimal;
  type: InventoryMovementType;
  referenceType?: string;
  referenceId?: string;
  /** Per-org unique — replays of the same source line skip instead of doubling. */
  dedupeKey: string;
  actorId?: string | null;
}

/**
 * One movement + its balance increment in a single transaction. A P2002 on
 * the dedupe key means a previous attempt committed the pair already: skip
 * and report `alreadyApplied` so callers treat it as success.
 */
export async function applyMovement(input: ApplyMovementInput): Promise<{ alreadyApplied: boolean }> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.inventoryMovement.create({
        data: {
          organizationId: input.organizationId,
          warehouseId: input.warehouseId,
          variantId: input.variantId,
          quantityDelta: input.quantityDelta,
          type: input.type,
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          dedupeKey: input.dedupeKey,
          actorId: input.actorId ?? null,
        },
      });
      await tx.inventoryBalance.upsert({
        where: {
          warehouseId_variantId: {
            warehouseId: input.warehouseId,
            variantId: input.variantId,
          },
        },
        create: {
          organizationId: input.organizationId,
          warehouseId: input.warehouseId,
          variantId: input.variantId,
          onHand: input.quantityDelta,
        },
        update: { onHand: { increment: input.quantityDelta } },
      });
    });
    return { alreadyApplied: false };
  } catch (error) {
    if (isUniqueViolation(error)) return { alreadyApplied: true };
    throw error;
  }
}

/** Resolve the store-linked warehouse or throw an operator-safe config gap. */
async function requireWarehouseId(orgId: string, storeId: string): Promise<string> {
  const warehouseId = await resolveWarehouseId(orgId, storeId);
  if (!warehouseId) {
    throw new InventoryError(
      400,
      "WAREHOUSE_NOT_MAPPED",
      "The receipt's store has no linked warehouse. Create a warehouse for the store under Settings - Warehouses.",
    );
  }
  return warehouseId;
}

export interface ProjectionResult {
  /** Movement rows written (or already applied) by this call. */
  movements: number;
  /** Lines skipped because their replay was already applied. */
  alreadyApplied: number;
}

/**
 * Apply a Loyverse receipt as SALE movements: one negative movement per
 * receipt line into the store-linked warehouse. Idempotent per line
 * (`sale:<lineId>`); re-runs skip already-applied lines.
 */
export async function applyReceiptSale(orgId: string, receiptId: string): Promise<ProjectionResult> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, organizationId: orgId },
    include: { lines: true },
  });
  if (!receipt) {
    throw new InventoryError(404, "NOT_FOUND", "Receipt not found.");
  }
  const warehouseId = await requireWarehouseId(orgId, receipt.storeId);

  let movements = 0;
  let alreadyApplied = 0;
  for (const line of receipt.lines) {
    if (!line.variantId) continue; // non-variant line — nothing to track
    const quantity = new Decimal(line.quantity as number | string | Prisma.Decimal);
    const result = await applyMovement({
      organizationId: orgId,
      warehouseId,
      variantId: line.variantId,
      quantityDelta: quantity.neg(),
      type: "SALE",
      referenceType: "Receipt",
      referenceId: receipt.id,
      dedupeKey: `sale:${line.id}`,
    });
    if (result.alreadyApplied) alreadyApplied += 1;
    else movements += 1;
  }
  return { movements, alreadyApplied };
}

/**
 * Apply a Loyverse refund as REFUND movements: one positive movement per
 * refund line back into the sale's warehouse. Idempotent per line
 * (`refund-return:<lineId>`).
 */
export async function applyRefundReturn(orgId: string, refundId: string): Promise<ProjectionResult> {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, organizationId: orgId },
    include: { lines: true, receipt: { select: { id: true, storeId: true } } },
  });
  if (!refund) {
    throw new InventoryError(404, "NOT_FOUND", "Refund not found.");
  }
  const warehouseId = await requireWarehouseId(orgId, refund.receipt.storeId);

  let movements = 0;
  let alreadyApplied = 0;
  for (const line of refund.lines) {
    if (!line.variantId) continue;
    const quantity = new Decimal(line.quantity as number | string | Prisma.Decimal);
    const result = await applyMovement({
      organizationId: orgId,
      warehouseId,
      variantId: line.variantId,
      quantityDelta: quantity,
      type: "REFUND",
      referenceType: "Refund",
      referenceId: refund.id,
      dedupeKey: `refund-return:${line.id}`,
    });
    if (result.alreadyApplied) alreadyApplied += 1;
    else movements += 1;
  }
  return { movements, alreadyApplied };
}

export interface SnapshotOutcome {
  status: "applied" | "alreadyApplied" | "noChange" | "skipped";
  reason?: "unknown-variant" | "unknown-store" | "no-warehouse";
}

/**
 * Apply an `inventory_levels.update` snapshot as one ADJUSTMENT movement:
 * delta = reported stock − current on-hand (first snapshot seeds from zero,
 * so balances stay exactly Σ movements). Zero-delta snapshots write no
 * movement — the balance did not change, so there is nothing to trace.
 * Unknown variant/store rows are skipped (the sync will repair master data;
 * the next snapshot covers the balance).
 */
export async function applyInventoryLevelSnapshot(
  orgId: string,
  input: {
    variantLoyverseId: string;
    storeLoyverseId: string;
    inStock: Prisma.Decimal;
    /** Unique per event + level — replays of the same event skip. */
    dedupeKey: string;
  },
): Promise<SnapshotOutcome> {
  const variant = await prisma.variant.findFirst({
    where: { organizationId: orgId, loyverseId: input.variantLoyverseId },
    select: { id: true },
  });
  if (!variant) return { status: "skipped", reason: "unknown-variant" };

  const store = await prisma.store.findFirst({
    where: { organizationId: orgId, loyverseStoreId: input.storeLoyverseId },
    select: { id: true },
  });
  if (!store) return { status: "skipped", reason: "unknown-store" };

  const warehouseId = await resolveWarehouseId(orgId, store.id);
  if (!warehouseId) return { status: "skipped", reason: "no-warehouse" };

  const balance = await prisma.inventoryBalance.findFirst({
    where: { warehouseId, variantId: variant.id },
    select: { onHand: true },
  });
  const current = balance ? new Decimal(balance.onHand as number | string | Prisma.Decimal) : new Decimal(0);
  const delta = input.inStock.minus(current);
  if (delta.eq(0)) return { status: "noChange" };

  const result = await applyMovement({
    organizationId: orgId,
    warehouseId,
    variantId: variant.id,
    quantityDelta: delta,
    type: "ADJUSTMENT",
    referenceType: "InventorySnapshot",
    referenceId: `${input.variantLoyverseId}:${input.storeLoyverseId}`,
    dedupeKey: input.dedupeKey,
  });
  return { status: result.alreadyApplied ? "alreadyApplied" : "applied" };
}
