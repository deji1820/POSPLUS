/**
 * Warehouse settings use-cases (SPEC.md §6 "Settings → Warehouses", and the
 * post-sync setup checklist's "warehouses/locations" item). List and
 * create/update warehouses within the tenant, optionally linked to a store.
 * The `code` is an org-scoped unique short code. Org scoped; SETTINGS only.
 */
import { z } from "zod";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SettingsError, validationError } from "@/lib/settings/errors";

export const warehouseInputSchema = z.object({
  name: z.string().trim().min(1, "Warehouse name is required.").max(200),
  code: z
    .string()
    .trim()
    .min(1, "Warehouse code is required.")
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Code may contain letters, digits, dashes, and underscores."),
  storeId: z.string().trim().max(100).optional().or(z.literal("").transform(() => undefined)),
  active: z.boolean().default(true),
});
export type WarehouseInput = z.infer<typeof warehouseInputSchema>;

export const updateWarehouseSchema = warehouseInputSchema.extend({ id: z.string().min(1) });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export interface WarehouseSummary {
  id: string;
  name: string;
  code: string;
  storeId: string | null;
  storeName: string | null;
  active: boolean;
}

const warehouseSelect = {
  id: true,
  name: true,
  code: true,
  storeId: true,
  active: true,
  store: { select: { name: true } },
} as const;

function toSummary(
  row: Prisma.WarehouseGetPayload<{ select: typeof warehouseSelect }>,
): WarehouseSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    storeId: row.storeId,
    storeName: row.store?.name ?? null,
    active: row.active,
  };
}

export async function listWarehouses(orgId: string): Promise<WarehouseSummary[]> {
  const rows = await prisma.warehouse.findMany({
    where: { organizationId: orgId },
    select: warehouseSelect,
    orderBy: { code: "asc" },
  });
  return rows.map(toSummary);
}

/** Ensure the linked store (if any) belongs to this tenant. */
async function assertStoreInOrg(orgId: string, storeId: string | undefined): Promise<void> {
  if (!storeId) return;
  const store = await prisma.store.findFirst({
    where: { id: storeId, organizationId: orgId },
    select: { id: true },
  });
  if (!store) {
    throw validationError("The selected store does not belong to this organization.");
  }
}

async function assertCodeFree(orgId: string, code: string, excludeId?: string): Promise<void> {
  const clash = await prisma.warehouse.findFirst({
    where: { organizationId: orgId, code, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw validationError(`Warehouse code "${code}" is already in use.`);
  }
}

export async function createWarehouse(
  orgId: string,
  input: WarehouseInput,
): Promise<WarehouseSummary> {
  await assertStoreInOrg(orgId, input.storeId);
  await assertCodeFree(orgId, input.code);
  const row = await prisma.warehouse.create({
    data: {
      organizationId: orgId,
      name: input.name,
      code: input.code,
      storeId: input.storeId ?? null,
      active: input.active,
    },
    select: warehouseSelect,
  });
  return toSummary(row);
}

export async function updateWarehouse(
  orgId: string,
  input: UpdateWarehouseInput,
): Promise<{ before: WarehouseSummary; after: WarehouseSummary }> {
  const existing = await prisma.warehouse.findFirst({
    where: { id: input.id, organizationId: orgId },
    select: warehouseSelect,
  });
  if (!existing) {
    throw new SettingsError(404, "NOT_FOUND", "Warehouse not found.");
  }
  await assertStoreInOrg(orgId, input.storeId);
  await assertCodeFree(orgId, input.code, input.id);
  const row = await prisma.warehouse.update({
    where: { id: input.id },
    data: {
      name: input.name,
      code: input.code,
      storeId: input.storeId ?? null,
      active: input.active,
    },
    select: warehouseSelect,
  });
  return { before: toSummary(existing), after: toSummary(row) };
}
