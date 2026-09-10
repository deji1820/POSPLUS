/**
 * Store settings use-cases (SPEC.md §6 "Settings → Stores"). List and
 * create/update stores within the tenant. Loyverse-linked stores carry a
 * `loyverseStoreId` (synced from the POS); operators may add manual stores
 * too. Org scoped; SETTINGS module (OWNER) only.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { SettingsError, validationError } from "@/lib/settings/errors";

export const storeInputSchema = z.object({
  name: z.string().trim().min(1, "Store name is required.").max(200),
  address: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
  timezone: z.string().trim().max(64).optional().or(z.literal("").transform(() => undefined)),
  loyverseStoreId: z
    .string()
    .trim()
    .max(100)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  active: z.boolean().default(true),
});
export type StoreInput = z.infer<typeof storeInputSchema>;

export const updateStoreSchema = storeInputSchema.extend({ id: z.string().min(1) });
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export interface StoreSummary {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  loyverseStoreId: string | null;
  active: boolean;
}

export async function listStores(orgId: string): Promise<StoreSummary[]> {
  return prisma.store.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      address: true,
      timezone: true,
      loyverseStoreId: true,
      active: true,
    },
    orderBy: { name: "asc" },
  });
}

/** Create a store; rejects a loyverseStoreId already used by this org. */
export async function createStore(
  orgId: string,
  input: StoreInput,
): Promise<StoreSummary> {
  if (input.loyverseStoreId) {
    const clash = await prisma.store.findFirst({
      where: { organizationId: orgId, loyverseStoreId: input.loyverseStoreId },
      select: { id: true },
    });
    if (clash) {
      throw validationError("Another store already uses that Loyverse store id.");
    }
  }
  return prisma.store.create({
    data: {
      organizationId: orgId,
      name: input.name,
      address: input.address ?? null,
      timezone: input.timezone ?? null,
      loyverseStoreId: input.loyverseStoreId ?? null,
      active: input.active,
    },
    select: {
      id: true,
      name: true,
      address: true,
      timezone: true,
      loyverseStoreId: true,
      active: true,
    },
  });
}

/** Update a store owned by this org; 404 when out of tenant. */
export async function updateStore(
  orgId: string,
  input: UpdateStoreInput,
): Promise<{ before: StoreSummary; after: StoreSummary }> {
  const existing = await prisma.store.findFirst({
    where: { id: input.id, organizationId: orgId },
    select: {
      id: true,
      name: true,
      address: true,
      timezone: true,
      loyverseStoreId: true,
      active: true,
    },
  });
  if (!existing) {
    throw new SettingsError(404, "NOT_FOUND", "Store not found.");
  }
  if (input.loyverseStoreId && input.loyverseStoreId !== existing.loyverseStoreId) {
    const clash = await prisma.store.findFirst({
      where: {
        organizationId: orgId,
        loyverseStoreId: input.loyverseStoreId,
        id: { not: input.id },
      },
      select: { id: true },
    });
    if (clash) {
      throw validationError("Another store already uses that Loyverse store id.");
    }
  }
  const after = await prisma.store.update({
    where: { id: input.id },
    data: {
      name: input.name,
      address: input.address ?? null,
      timezone: input.timezone ?? null,
      loyverseStoreId: input.loyverseStoreId ?? null,
      active: input.active,
    },
    select: {
      id: true,
      name: true,
      address: true,
      timezone: true,
      loyverseStoreId: true,
      active: true,
    },
  });
  return { before: existing, after };
}
