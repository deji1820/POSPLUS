/**
 * Inventory read model (SPEC.md §6 "/supply-chain/inventory", issue #16).
 *
 * Org-scoped by construction; store/warehouse-scoped roles see only their
 * assigned rows (§5). Balances expose the reorder fields from the row plus
 * a derived suggested-reorder quantity; movements are the traceability
 * ledger behind every balance (acceptance: movements reconcile to
 * balances by construction — balances are only ever written as Σ movements
 * in lib/inventory/projection.ts).
 */
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { InventoryError } from "@/lib/inventory/errors";

const Decimal = Prisma.Decimal;

/** Optional narrowing from UserStoreAccess / UserWarehouseAccess (null = unrestricted). */
export interface InventoryScope {
  storeIds: string[] | null;
  warehouseIds: string[] | null;
}

export const balanceFilterSchema = z.object({
  storeId: z.string().min(1).optional(),
  warehouseId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  /** "1" filters to rows at or below their reorder point. */
  lowStock: z.string().optional(),
});
export type BalanceFilters = z.infer<typeof balanceFilterSchema>;

export interface BalanceSummary {
  warehouse: { id: string; name: string; storeId: string | null; storeName: string | null };
  variant: { id: string; name: string; sku: string | null };
  item: { id: string; name: string };
  onHand: string;
  reserved: string;
  reorderPoint: string | null;
  targetStock: string | null;
  /** max(0, targetStock − onHand) when a target is configured, else null. */
  suggestedReorderQty: string | null;
  /** onHand ≤ reorderPoint (when a reorder point is configured). */
  lowStock: boolean;
}

function toQty(value: unknown): Prisma.Decimal {
  return new Decimal(value as number | string | Prisma.Decimal);
}

function scopeWhere(scope: InventoryScope): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  if (scope.storeIds) and.push({ warehouse: { storeId: { in: scope.storeIds } } });
  if (scope.warehouseIds) and.push({ warehouseId: { in: scope.warehouseIds } });
  return and.length > 0 ? { AND: and } : {};
}

function filterWhere(orgId: string, filters: BalanceFilters): Record<string, unknown> {
  const and: Record<string, unknown>[] = [{ organizationId: orgId }];
  if (filters.storeId) and.push({ warehouse: { storeId: filters.storeId } });
  if (filters.warehouseId) and.push({ warehouseId: filters.warehouseId });
  if (filters.itemId) and.push({ variant: { itemId: filters.itemId } });
  if (filters.variantId) and.push({ variantId: filters.variantId });
  return { AND: and };
}

/** Filtered balance list, ordered by item → variant name. */
export async function listInventoryBalances(
  orgId: string,
  scope: InventoryScope,
  rawFilters: unknown,
): Promise<BalanceSummary[]> {
  const parsed = balanceFilterSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw new InventoryError(400, "VALIDATION_ERROR", "Invalid inventory filter parameters.");
  }
  const filters = parsed.data;

  const where = filterWhere(orgId, filters);
  const scopeAnd = scopeWhere(scope);
  if (scopeAnd.AND) (where.AND as Record<string, unknown>[]).push(...(scopeAnd.AND as Record<string, unknown>[]));

  const rows = await prisma.inventoryBalance.findMany({
    where: where as never,
    include: {
      variant: { select: { id: true, name: true, sku: true, item: { select: { id: true, name: true } } } },
      warehouse: { select: { id: true, name: true, storeId: true, store: { select: { name: true } } } },
    },
    orderBy: { variant: { item: { name: "asc" } } },
  });

  const summaries = rows.map((row) => {
    const onHand = toQty(row.onHand);
    const reorderPoint = row.reorderPoint === null ? null : toQty(row.reorderPoint);
    const targetStock = row.targetStock === null ? null : toQty(row.targetStock);
    return {
      warehouse: {
        id: row.warehouse.id,
        name: row.warehouse.name,
        storeId: row.warehouse.storeId,
        storeName: row.warehouse.store?.name ?? null,
      },
      variant: { id: row.variant.id, name: row.variant.name, sku: row.variant.sku },
      item: { id: row.variant.item.id, name: row.variant.item.name },
      onHand: onHand.toString(),
      reserved: toQty(row.reserved).toString(),
      reorderPoint: reorderPoint?.toString() ?? null,
      targetStock: targetStock?.toString() ?? null,
      suggestedReorderQty:
        targetStock === null
          ? null
          : (() => {
              const shortage = targetStock.minus(onHand);
              return (shortage.gt(0) ? shortage : new Decimal(0)).toString();
            })(),
      lowStock: reorderPoint !== null && onHand.lte(reorderPoint),
    };
  });

  return filters.lowStock === "1" ? summaries.filter((row) => row.lowStock) : summaries;
}

export const MOVEMENT_TYPES = [
  "SALE",
  "REFUND",
  "RECEIPT",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "PRODUCTION_CONSUME",
  "PRODUCTION_OUTPUT",
  "ADJUSTMENT",
] as const;

export const movementFilterSchema = z.object({
  storeId: z.string().min(1).optional(),
  warehouseId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MovementFilters = z.infer<typeof movementFilterSchema>;

export interface MovementSummary {
  id: string;
  createdAt: string; // ISO
  warehouse: { id: string; name: string; storeName: string | null };
  variant: { id: string; name: string; itemName: string };
  quantityDelta: string;
  type: string;
  referenceType: string | null;
  referenceId: string | null;
}

/** Filtered movement ledger, newest first, cursor-paginated. */
export async function listInventoryMovements(
  orgId: string,
  scope: InventoryScope,
  rawFilters: unknown,
): Promise<{ entries: MovementSummary[]; nextCursor: string | null }> {
  const parsed = movementFilterSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw new InventoryError(400, "VALIDATION_ERROR", "Invalid movement filter parameters.");
  }
  const filters = parsed.data;
  const from = filters.from ? new Date(filters.from) : null;
  const to = filters.to ? new Date(filters.to) : null;
  if ((filters.from && (from === null || Number.isNaN(from.getTime()))) ||
      (filters.to && (to === null || Number.isNaN(to.getTime())))) {
    throw new InventoryError(400, "VALIDATION_ERROR", "Invalid movement filter parameters.");
  }

  const and: Record<string, unknown>[] = [{ organizationId: orgId }];
  if (scope.storeIds) and.push({ warehouse: { storeId: { in: scope.storeIds } } });
  if (scope.warehouseIds) and.push({ warehouseId: { in: scope.warehouseIds } });
  if (filters.storeId) and.push({ warehouse: { storeId: filters.storeId } });
  if (filters.warehouseId) and.push({ warehouseId: filters.warehouseId });
  if (filters.itemId) and.push({ variant: { itemId: filters.itemId } });
  if (filters.variantId) and.push({ variantId: filters.variantId });
  if (filters.type) and.push({ type: filters.type });
  if (from || to) {
    and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
  }

  const rows = await prisma.inventoryMovement.findMany({
    where: { AND: and } as never,
    include: {
      variant: { select: { id: true, name: true, item: { select: { name: true } } } },
      warehouse: { select: { id: true, name: true, store: { select: { name: true } } } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filters.limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, filters.limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      warehouse: {
        id: row.warehouse.id,
        name: row.warehouse.name,
        storeName: row.warehouse.store?.name ?? null,
      },
      variant: { id: row.variant.id, name: row.variant.name, itemName: row.variant.item.name },
      quantityDelta: toQty(row.quantityDelta).toString(),
      type: row.type,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
    })),
    nextCursor: rows.length > filters.limit ? page[page.length - 1].id : null,
  };
}
