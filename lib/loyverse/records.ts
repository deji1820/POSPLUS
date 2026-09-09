/**
 * Per-record Loyverse → POSPLUS upserts (SPEC.md §9), shared by the sync
 * engine (lib/loyverse/sync/engine.ts, bulk pages) and the webhook handlers
 * (lib/loyverse/webhook/handlers.ts, single records). Both paths must apply
 * IDENTICAL defensive mapping — Loyverse payloads evolve; missing fields must
 * degrade to null/0, never throw mid-run — so the mapping lives here exactly
 * once.
 *
 * Every write is an org-scoped upsert keyed on the Loyverse id, making
 * re-processed pages AND redelivered webhooks idempotent.
 */
import { prisma } from "@/lib/db";

// ---------------------------------------------------------------------------
// Defensive field extraction
// ---------------------------------------------------------------------------

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

export function money(value: unknown): number {
  return asNumber(value) ?? 0;
}

/** Loyverse dates look like "2024-01-15 10:30:45 +0000" — normalize to Date. */
export function parseLoyverseDate(value: unknown): Date | null {
  const raw = asString(value);
  if (!raw) return null;
  // Normalize the Loyverse shape to a strict ISO-8601 string, converting the
  // "+0000" offset (no colon) to "+00:00" which Date parses deterministically.
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?$/.exec(raw.trim());
  const iso = match
    ? match[3]
      ? `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`
      : `${match[1]}T${match[2]}Z`
    : raw;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

// ---------------------------------------------------------------------------
// stores
// ---------------------------------------------------------------------------

export async function upsertStoreRecord(
  orgId: string,
  store: Record<string, unknown>,
): Promise<boolean> {
  const loyverseId = asString(store.id);
  if (!loyverseId) return false;
  const address = store.address;
  const addressLine =
    typeof address === "string"
      ? address
      : address && typeof address === "object"
        ? (asString((address as Record<string, unknown>).line1) ??
          asString((address as Record<string, unknown>).address_line1))
        : null;
  await prisma.store.upsert({
    where: { organizationId_loyverseStoreId: { organizationId: orgId, loyverseStoreId: loyverseId } },
    create: {
      organizationId: orgId,
      loyverseStoreId: loyverseId,
      name: asString(store.name) ?? "Unnamed store",
      address: addressLine,
      timezone: asString(store.timezone),
    },
    update: {
      name: asString(store.name) ?? "Unnamed store",
      address: addressLine,
      timezone: asString(store.timezone),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export async function upsertCategoryRecord(
  orgId: string,
  category: Record<string, unknown>,
): Promise<boolean> {
  const loyverseId = asString(category.id);
  if (!loyverseId) return false;
  await prisma.category.upsert({
    where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
    create: {
      organizationId: orgId,
      loyverseId,
      name: asString(category.name) ?? "Unnamed category",
    },
    update: { name: asString(category.name) ?? "Unnamed category" },
  });
  return true;
}

/**
 * Link a category to its parent (both keyed by Loyverse id). No-op unless
 * BOTH exist locally — the sync engine runs a full second pass after all
 * upserts (a parent may sort after its child); webhooks attempt the link
 * immediately and simply no-op when the parent has not been seen yet.
 */
export async function linkCategoryParent(
  orgId: string,
  category: Record<string, unknown>,
): Promise<void> {
  const loyverseId = asString(category.id);
  const parentLoyverseId = asString(category.parent_id);
  if (!loyverseId || !parentLoyverseId) return;
  const [child, parent] = await Promise.all([
    prisma.category.findUnique({
      where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
      select: { id: true },
    }),
    prisma.category.findUnique({
      where: {
        organizationId_loyverseId: { organizationId: orgId, loyverseId: parentLoyverseId },
      },
      select: { id: true },
    }),
  ]);
  if (child && parent) {
    await prisma.category.update({ where: { id: child.id }, data: { parentId: parent.id } });
  }
}

// ---------------------------------------------------------------------------
// items + variants
// ---------------------------------------------------------------------------

export async function upsertItemRecord(
  orgId: string,
  item: Record<string, unknown>,
): Promise<number> {
  const loyverseId = asString(item.id);
  if (!loyverseId) return 0;
  const categoryLoyverseId = asString(item.category_id);
  const category = categoryLoyverseId
    ? await prisma.category.findUnique({
        where: {
          organizationId_loyverseId: { organizationId: orgId, loyverseId: categoryLoyverseId },
        },
        select: { id: true },
      })
    : null;
  const local = await prisma.item.upsert({
    where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
    create: {
      organizationId: orgId,
      loyverseId,
      name: asString(item.item_name) ?? asString(item.name) ?? "Unnamed item",
      categoryId: category?.id ?? null,
      itemType: asString(item.item_type),
    },
    update: {
      name: asString(item.item_name) ?? asString(item.name) ?? "Unnamed item",
      categoryId: category?.id ?? null,
      itemType: asString(item.item_type),
    },
  });
  let variants = 0;
  const itemVariants = Array.isArray(item.variants) ? item.variants : [];
  for (const variant of itemVariants as Record<string, unknown>[]) {
    const variantLoyverseId = asString(variant.id);
    if (!variantLoyverseId) continue;
    await prisma.variant.upsert({
      where: {
        organizationId_loyverseId: { organizationId: orgId, loyverseId: variantLoyverseId },
      },
      create: {
        organizationId: orgId,
        loyverseId: variantLoyverseId,
        itemId: local.id,
        name: asString(variant.name) ?? "Default",
        sku: asString(variant.sku),
        price: money(variant.price),
        defaultCost: money(variant.default_cost),
      },
      update: {
        name: asString(variant.name) ?? "Default",
        sku: asString(variant.sku),
        price: money(variant.price),
        defaultCost: money(variant.default_cost),
      },
    });
    variants += 1;
  }
  return variants;
}

// ---------------------------------------------------------------------------
// employees / customers
// ---------------------------------------------------------------------------

export async function upsertEmployeeRecord(
  orgId: string,
  employee: Record<string, unknown>,
): Promise<boolean> {
  const loyverseId = asString(employee.id);
  if (!loyverseId) return false;
  await prisma.employee.upsert({
    where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
    create: {
      organizationId: orgId,
      loyverseId,
      name: asString(employee.name) ?? "Unnamed employee",
      email: asString(employee.email),
      loyverseRole: asString(employee.role),
    },
    update: {
      name: asString(employee.name) ?? "Unnamed employee",
      email: asString(employee.email),
      loyverseRole: asString(employee.role),
    },
  });
  return true;
}

export async function upsertCustomerRecord(
  orgId: string,
  customer: Record<string, unknown>,
): Promise<boolean> {
  const loyverseId = asString(customer.id);
  if (!loyverseId) return false;
  await prisma.customer.upsert({
    where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
    create: {
      organizationId: orgId,
      loyverseId,
      name: asString(customer.name) ?? "Unnamed customer",
      email: asString(customer.email),
      phone: asString(customer.phone_number),
    },
    update: {
      name: asString(customer.name) ?? "Unnamed customer",
      email: asString(customer.email),
      phone: asString(customer.phone_number),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// receipts + refunds
// ---------------------------------------------------------------------------

export type ReceiptUpsertResult =
  | { ok: true; refunds: number }
  | { ok: false; reason: "missing-id" | "unknown-store" };

async function resolveVariantId(
  orgId: string,
  line: Record<string, unknown>,
): Promise<string | null> {
  const variantLoyverseId = asString(line.variant_id) ?? asString(line.item_variant_id);
  if (!variantLoyverseId) return null;
  const variant = await prisma.variant.findUnique({
    where: {
      organizationId_loyverseId: { organizationId: orgId, loyverseId: variantLoyverseId },
    },
    select: { id: true },
  });
  return variant?.id ?? null;
}

/**
 * Idempotent upsert of one receipt (+lines, +refunds riding on the payload).
 * A receipt whose store is unknown locally (e.g. the store webhook has not
 * landed yet) is rejected with "unknown-store" — it has a required store FK
 * and inserting it would corrupt the reference. The caller decides what to do
 * (sync skips; the webhook processor marks the event FAILED so it surfaces).
 */
export async function upsertReceiptRecord(
  orgId: string,
  receipt: Record<string, unknown>,
): Promise<ReceiptUpsertResult> {
  const loyverseId = asString(receipt.id);
  if (!loyverseId) return { ok: false, reason: "missing-id" };

  const storeLoyverseId = asString(receipt.store_id);
  const store = storeLoyverseId
    ? await prisma.store.findUnique({
        where: {
          organizationId_loyverseStoreId: { organizationId: orgId, loyverseStoreId: storeLoyverseId },
        },
        select: { id: true },
      })
    : null;
  if (!store) return { ok: false, reason: "unknown-store" };

  const employeeLoyverseId = asString(receipt.employee_id);
  const employee = employeeLoyverseId
    ? await prisma.employee.findUnique({
        where: {
          organizationId_loyverseId: { organizationId: orgId, loyverseId: employeeLoyverseId },
        },
        select: { id: true },
      })
    : null;
  const customerLoyverseId = asString(receipt.customer_id);
  const customer = customerLoyverseId
    ? await prisma.customer.findUnique({
        where: {
          organizationId_loyverseId: { organizationId: orgId, loyverseId: customerLoyverseId },
        },
        select: { id: true },
      })
    : null;

  const lineItems = Array.isArray(receipt.line_items) ? receipt.line_items : [];
  // Resolve variant links before insert so lines are created fully formed
  // (lines are immutable from the source; later retries no-op).
  const resolvedLines = [];
  for (const line of lineItems as Record<string, unknown>[]) {
    resolvedLines.push({
      organizationId: orgId,
      variantId: (await resolveVariantId(orgId, line)) ?? undefined,
      itemName: asString(line.item_name) ?? asString(line.name) ?? null,
      quantity: money(line.quantity),
      price: money(line.price),
      total: money(line.total_money ?? line.total),
    });
  }
  const local = await prisma.receipt.upsert({
    where: { organizationId_loyverseId: { organizationId: orgId, loyverseId } },
    create: {
      organizationId: orgId,
      loyverseId,
      storeId: store.id,
      employeeId: employee?.id ?? null,
      customerId: customer?.id ?? null,
      receiptNumber: asString(receipt.receipt_number),
      paymentType: asString(receipt.payment_type),
      subtotal: money(receipt.subtotal),
      total: money(receipt.total_money ?? receipt.total),
      openedAt: parseLoyverseDate(receipt.created_at) ?? new Date(),
      lines: { create: resolvedLines },
    },
    update: {
      employeeId: employee?.id ?? null,
      customerId: customer?.id ?? null,
      receiptNumber: asString(receipt.receipt_number),
      paymentType: asString(receipt.payment_type),
      subtotal: money(receipt.subtotal),
      total: money(receipt.total_money ?? receipt.total),
    },
  });

  // Refunds ride along on the receipt payload.
  let refunds = 0;
  const receiptRefunds = Array.isArray(receipt.refunds) ? receipt.refunds : [];
  for (const refund of receiptRefunds as Record<string, unknown>[]) {
    const refundLoyverseId = asString(refund.id);
    if (!refundLoyverseId) continue;
    const refundLineItems = Array.isArray(refund.line_items) ? refund.line_items : [];
    const resolvedRefundLines = [];
    for (const line of refundLineItems as Record<string, unknown>[]) {
      resolvedRefundLines.push({
        organizationId: orgId,
        variantId: (await resolveVariantId(orgId, line)) ?? undefined,
        itemName: asString(line.item_name) ?? asString(line.name) ?? null,
        quantity: money(line.quantity),
        price: money(line.price),
        total: money(line.total_money ?? line.total),
      });
    }
    await prisma.refund.upsert({
      where: {
        organizationId_loyverseId: { organizationId: orgId, loyverseId: refundLoyverseId },
      },
      create: {
        organizationId: orgId,
        loyverseId: refundLoyverseId,
        receiptId: local.id,
        total: money(refund.total_money ?? refund.total),
        reason: asString(refund.reason),
        lines: { create: resolvedRefundLines },
      },
      update: {
        total: money(refund.total_money ?? refund.total),
        reason: asString(refund.reason),
      },
    });
    refunds += 1;
  }
  return { ok: true, refunds };
}
