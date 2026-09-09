/**
 * Loyverse sync engine (SPEC.md §9) — runs inside the BullMQ worker, never
 * in an HTTP request.
 *
 * Ordered sequence: validate credential → stores → categories → items(+variants)
 * → employees → customers → receipts(+refunds) → mark complete. Each resource
 * is cursor-paginated; after every page the engine persists a checkpoint
 * (done resources + per-resource cursors + cumulative counts) on the SyncRun,
 * so a retried job resumes where the failed attempt stopped instead of
 * starting over. All writes are org-scoped upserts keyed on the Loyverse id,
 * making re-processed pages idempotent.
 *
 * INCREMENTAL runs fetch only records changed since the last successful sync
 * (updated_at_min / created_at_min) and always scan the full delta — the
 * done/cursor checkpoints apply to full (INITIAL/MANUAL) runs only.
 */
import type { SyncRun } from "@prisma/client";

import { validateApiKey } from "@/lib/loyverse/client";
import { LoyverseHttp, type Sleep } from "@/lib/loyverse/http";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/encryption";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

export const RESOURCE_ORDER = [
  "stores",
  "categories",
  "items",
  "employees",
  "customers",
  "receipts",
] as const;

export type ResourceName = (typeof RESOURCE_ORDER)[number];

export interface SyncProgress {
  done: string[];
  cursors: Record<string, string>;
}

const PAGE_SIZE = 250;

// ---------------------------------------------------------------------------
// Defensive field extraction — Loyverse payloads evolve; missing fields must
// degrade to null/0, never throw mid-run.
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function money(value: unknown): number {
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

function parseProgress(raw: unknown): SyncProgress {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const p = raw as { done?: unknown; cursors?: unknown };
    return {
      done: Array.isArray(p.done) ? p.done.filter((d): d is string => typeof d === "string") : [],
      cursors:
        p.cursors && typeof p.cursors === "object" && !Array.isArray(p.cursors)
          ? Object.fromEntries(
              Object.entries(p.cursors as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {},
    };
  }
  return { done: [], cursors: {} };
}

function parseCounts(raw: unknown): Record<string, number> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  }
  return {};
}

function sinceParam(run: SyncRun, lastSyncAt: Date | null): string | undefined {
  if (run.type !== "INCREMENTAL" || !lastSyncAt) return undefined;
  return lastSyncAt.toISOString();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SyncEngineOptions {
  sleep?: Sleep;
}

export async function runLoyverseSync(
  run: SyncRun,
  options: SyncEngineOptions = {},
): Promise<{ counts: Record<string, number> }> {
  const connection = await prisma.loyverseConnection.findUnique({
    where: { organizationId: run.organizationId },
  });
  if (!connection) {
    throw new UnrecoverableError("No Loyverse connection exists for this organization.");
  }

  // Step 1 — validate the stored credential before touching synced data.
  const apiKey = decryptSecret(connection.encryptedApiKey).plaintext;
  const check = await validateApiKey(apiKey);
  if (!check.ok) {
    if (check.reason === "invalid") {
      throw new UnrecoverableError(
        "Loyverse rejected the stored API key. Reconnect Loyverse in Settings.",
      );
    }
    throw new TransientJobError("Loyverse is unreachable; the sync will be retried.");
  }

  const http = new LoyverseHttp(apiKey, options.sleep);
  const orgId = run.organizationId;
  const fullRun = run.type !== "INCREMENTAL";
  const since = sinceParam(run, connection.lastSyncAt);
  const progress = parseProgress(run.progress);
  const counts = parseCounts(run.counts);
  const jobId = `sync-${run.id}`;

  for (const resource of RESOURCE_ORDER) {
    // Resume: skip resources a previous attempt fully persisted. Delta runs
    // always re-scan — the window is small and checkpoints don't apply.
    if (fullRun && progress.done.includes(resource)) continue;

    jobLog(jobId, "sync resource start", { resource, resumeCursor: progress.cursors[resource] ?? null });
    const process = RESOURCE_PROCESSORS[resource];
    // Per-page count merging happens inside forEachPage so a mid-resource
    // checkpoint carries cumulative counts; the processor itself returns void.
    await process(ctx(http, run.id, orgId, since, jobId, resource, progress, counts));
    if (fullRun) {
      progress.done.push(resource);
      delete progress.cursors[resource];
    }
    await saveCheckpoint(run.id, progress, counts);
    jobLog(jobId, "sync resource done", { resource, total: counts[resource] ?? 0 });
  }

  // Step 10 — mark complete: stamp the connection so the next INCREMENTAL
  // run knows where to start from.
  await prisma.loyverseConnection.update({
    where: { organizationId: orgId },
    data: { lastSyncAt: new Date() },
  });

  // Step 11 — post-sync setup checklist (default COA / GL mappings) is the
  // #10 follow-up; hook it here when that lands.
  jobLog(jobId, "sync complete", { counts });
  return { counts };
}

// ---------------------------------------------------------------------------
// Per-resource processors
// ---------------------------------------------------------------------------

interface ResourceContext {
  http: LoyverseHttp;
  runId: string;
  orgId: string;
  since: string | undefined;
  jobId: string;
  resource: ResourceName;
  progress: SyncProgress;
  counts: Record<string, number>;
}

function ctx(
  http: LoyverseHttp,
  runId: string,
  orgId: string,
  since: string | undefined,
  jobId: string,
  resource: ResourceName,
  progress: SyncProgress,
  counts: Record<string, number>,
): ResourceContext {
  return { http, runId, orgId, since, jobId, resource, progress, counts };
}

interface ResourceResult {
  main: number;
  extra?: Record<string, number>;
}

const RESOURCE_PROCESSORS: Record<ResourceName, (c: ResourceContext) => Promise<void>> = {
  stores: syncStores,
  categories: syncCategories,
  items: syncItems,
  employees: syncEmployees,
  customers: syncCustomers,
  receipts: syncReceipts,
};

async function saveCheckpoint(
  runId: string,
  progress: SyncProgress,
  counts: Record<string, number>,
): Promise<void> {
  // Deep-copy: the live progress/counts objects keep mutating during the run
  // (done.push, cursors delete, count merges) — a snapshot must be frozen.
  await prisma.syncRun.update({
    where: { id: runId },
    data: {
      progress: { done: [...progress.done], cursors: { ...progress.cursors } },
      counts: { ...counts },
    },
  });
}

/**
 * Paginate a resource, merging each page's counts and persisting the cursor
 * after every page — so a retried job resumes mid-resource with cumulative
 * counts, never double-counting completed pages.
 */
async function forEachPage(
  c: ResourceContext,
  path: string,
  params: Record<string, string | number | undefined>,
  onPage: (items: Record<string, unknown>[]) => Promise<ResourceResult>,
): Promise<void> {
  for await (const page of c.http.paginate(path, {
    ...params,
    limit: PAGE_SIZE,
    cursor: c.progress.cursors[c.resource],
  })) {
    const result = await onPage(page.items);
    c.counts[c.resource] = (c.counts[c.resource] ?? 0) + result.main;
    if (result.extra) {
      for (const [key, value] of Object.entries(result.extra)) {
        c.counts[key] = (c.counts[key] ?? 0) + value;
      }
    }
    if (page.cursor) {
      c.progress.cursors[c.resource] = page.cursor;
      await saveCheckpoint(c.runId, c.progress, c.counts);
    }
  }
}

// --- stores -----------------------------------------------------------------

async function syncStores(c: ResourceContext): Promise<void> {
  await forEachPage(c, "/stores", { updated_at_min: c.since }, async (items) => {
    for (const store of items) {
      const loyverseId = asString(store.id);
      if (!loyverseId) continue;
      const address = store.address;
      const addressLine =
        typeof address === "string"
          ? address
          : address && typeof address === "object"
            ? (asString((address as Record<string, unknown>).line1) ??
              asString((address as Record<string, unknown>).address_line1))
            : null;
      await prisma.store.upsert({
        where: { organizationId_loyverseStoreId: { organizationId: c.orgId, loyverseStoreId: loyverseId } },
        create: {
          organizationId: c.orgId,
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
    }
    return { main: items.length };
  });
}

// --- categories --------------------------------------------------------------

async function syncCategories(c: ResourceContext): Promise<void> {
  const pages: Record<string, unknown>[][] = [];
  await forEachPage(
    c,
    "/categories",
    { updated_at_min: c.since },
    async (items) => {
      pages.push(items);
      for (const category of items) {
        const loyverseId = asString(category.id);
        if (!loyverseId) continue;
        await prisma.category.upsert({
          where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
          create: {
            organizationId: c.orgId,
            loyverseId,
            name: asString(category.name) ?? "Unnamed category",
          },
          update: { name: asString(category.name) ?? "Unnamed category" },
        });
      }
      return { main: items.length };
    },
  );
  // Second pass: link parents now that every category in the run exists.
  for (const items of pages) {
    for (const category of items) {
      const loyverseId = asString(category.id);
      const parentLoyverseId = asString(category.parent_id);
      if (!loyverseId || !parentLoyverseId) continue;
      const [child, parent] = await Promise.all([
        prisma.category.findUnique({
          where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
          select: { id: true },
        }),
        prisma.category.findUnique({
          where: {
            organizationId_loyverseId: { organizationId: c.orgId, loyverseId: parentLoyverseId },
          },
          select: { id: true },
        }),
      ]);
      if (child && parent) {
        await prisma.category.update({
          where: { id: child.id },
          data: { parentId: parent.id },
        });
      }
    }
  }
}

// --- items + variants ----------------------------------------------------------

async function syncItems(c: ResourceContext): Promise<void> {
  await forEachPage(c, "/items", { updated_at_min: c.since }, async (items) => {
    let pageVariants = 0;
    for (const item of items) {
      const loyverseId = asString(item.id);
      if (!loyverseId) continue;
      const categoryLoyverseId = asString(item.category_id);
      const category = categoryLoyverseId
        ? await prisma.category.findUnique({
            where: {
              organizationId_loyverseId: { organizationId: c.orgId, loyverseId: categoryLoyverseId },
            },
            select: { id: true },
          })
        : null;
      const local = await prisma.item.upsert({
        where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
        create: {
          organizationId: c.orgId,
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
      const itemVariants = Array.isArray(item.variants) ? item.variants : [];
      for (const variant of itemVariants as Record<string, unknown>[]) {
        const variantLoyverseId = asString(variant.id);
        if (!variantLoyverseId) continue;
        await prisma.variant.upsert({
          where: {
            organizationId_loyverseId: { organizationId: c.orgId, loyverseId: variantLoyverseId },
          },
          create: {
            organizationId: c.orgId,
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
        pageVariants += 1;
      }
    }
    return { main: items.length, extra: { variants: pageVariants } };
  });
}

// --- employees -----------------------------------------------------------------

async function syncEmployees(c: ResourceContext): Promise<void> {
  await forEachPage(
    c,
    "/employees",
    { updated_at_min: c.since },
    async (items) => {
      for (const employee of items) {
        const loyverseId = asString(employee.id);
        if (!loyverseId) continue;
        await prisma.employee.upsert({
          where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
          create: {
            organizationId: c.orgId,
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
      }
      return { main: items.length };
    },
  );
}

// --- customers -------------------------------------------------------------------

async function syncCustomers(c: ResourceContext): Promise<void> {
  await forEachPage(
    c,
    "/customers",
    { updated_at_min: c.since },
    async (items) => {
      for (const customer of items) {
        const loyverseId = asString(customer.id);
        if (!loyverseId) continue;
        await prisma.customer.upsert({
          where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
          create: {
            organizationId: c.orgId,
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
      }
      return { main: items.length };
    },
  );
}

// --- receipts + refunds -------------------------------------------------------------

interface LocalLookup {
  storeId: string; // guaranteed: resolveReceiptRefs returns null when no store
  employeeId: string | null;
  customerId: string | null;
}

async function resolveReceiptRefs(
  c: ResourceContext,
  receipt: Record<string, unknown>,
): Promise<LocalLookup | null> {
  const storeLoyverseId = asString(receipt.store_id);
  const store = storeLoyverseId
    ? await prisma.store.findUnique({
        where: {
          organizationId_loyverseStoreId: { organizationId: c.orgId, loyverseStoreId: storeLoyverseId },
        },
        select: { id: true },
      })
    : null;
  // Receipts require a store FK; a receipt whose store is unknown (e.g. the
  // store list is incomplete) is skipped rather than corrupting the FK.
  if (!store) return null;

  const employeeLoyverseId = asString(receipt.employee_id);
  const employee = employeeLoyverseId
    ? await prisma.employee.findUnique({
        where: {
          organizationId_loyverseId: { organizationId: c.orgId, loyverseId: employeeLoyverseId },
        },
        select: { id: true },
      })
    : null;
  const customerLoyverseId = asString(receipt.customer_id);
  const customer = customerLoyverseId
    ? await prisma.customer.findUnique({
        where: {
          organizationId_loyverseId: { organizationId: c.orgId, loyverseId: customerLoyverseId },
        },
        select: { id: true },
      })
    : null;
  return { storeId: store.id, employeeId: employee?.id ?? null, customerId: customer?.id ?? null };
}

async function resolveVariant(
  c: ResourceContext,
  line: Record<string, unknown>,
): Promise<string | null> {
  const variantLoyverseId = asString(line.variant_id) ?? asString(line.item_variant_id);
  if (!variantLoyverseId) return null;
  const variant = await prisma.variant.findUnique({
    where: {
      organizationId_loyverseId: { organizationId: c.orgId, loyverseId: variantLoyverseId },
    },
    select: { id: true },
  });
  return variant?.id ?? null;
}

async function syncReceipts(c: ResourceContext): Promise<void> {
  await forEachPage(
    c,
    "/receipts",
    { created_at_min: c.since },
    async (items) => {
      let upserted = 0;
      let pageRefunds = 0;
      for (const receipt of items) {
        const loyverseId = asString(receipt.id);
        if (!loyverseId) continue;
        const refs = await resolveReceiptRefs(c, receipt);
        if (!refs) {
          jobLog(c.jobId, "receipt skipped: unknown store", {
            receiptId: loyverseId,
          });
          continue;
        }
        const lineItems = Array.isArray(receipt.line_items) ? receipt.line_items : [];
        // Resolve variant links before insert so lines are created fully
        // formed (lines are immutable from the source; later retries no-op).
        const resolvedLines = [];
        for (const line of lineItems as Record<string, unknown>[]) {
          resolvedLines.push({
            organizationId: c.orgId,
            variantId: (await resolveVariant(c, line)) ?? undefined,
            itemName: asString(line.item_name) ?? asString(line.name) ?? null,
            quantity: money(line.quantity),
            price: money(line.price),
            total: money(line.total_money ?? line.total),
          });
        }
        const local = await prisma.receipt.upsert({
          where: { organizationId_loyverseId: { organizationId: c.orgId, loyverseId } },
          create: {
            organizationId: c.orgId,
            loyverseId,
            storeId: refs.storeId,
            employeeId: refs.employeeId,
            customerId: refs.customerId,
            receiptNumber: asString(receipt.receipt_number),
            paymentType: asString(receipt.payment_type),
            subtotal: money(receipt.subtotal),
            total: money(receipt.total_money ?? receipt.total),
            openedAt: parseLoyverseDate(receipt.created_at) ?? new Date(),
            lines: { create: resolvedLines },
          },
          update: {
            employeeId: refs.employeeId,
            customerId: refs.customerId,
            receiptNumber: asString(receipt.receipt_number),
            paymentType: asString(receipt.payment_type),
            subtotal: money(receipt.subtotal),
            total: money(receipt.total_money ?? receipt.total),
          },
        });
        // Refunds ride along on the receipt payload.
        const receiptRefunds = Array.isArray(receipt.refunds) ? receipt.refunds : [];
        for (const refund of receiptRefunds as Record<string, unknown>[]) {
          const refundLoyverseId = asString(refund.id);
          if (!refundLoyverseId) continue;
          const refundLineItems = Array.isArray(refund.line_items) ? refund.line_items : [];
          const resolvedRefundLines = [];
          for (const line of refundLineItems as Record<string, unknown>[]) {
            resolvedRefundLines.push({
              organizationId: c.orgId,
              variantId: (await resolveVariant(c, line)) ?? undefined,
              itemName: asString(line.item_name) ?? asString(line.name) ?? null,
              quantity: money(line.quantity),
              price: money(line.price),
              total: money(line.total_money ?? line.total),
            });
          }
          await prisma.refund.upsert({
            where: {
              organizationId_loyverseId: { organizationId: c.orgId, loyverseId: refundLoyverseId },
            },
            create: {
              organizationId: c.orgId,
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
          pageRefunds += 1;
        }
        upserted += 1;
      }
      return { main: upserted, extra: { refunds: pageRefunds } };
    },
  );
}
