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
import {
  linkCategoryParent,
  parseLoyverseDate,
  upsertCategoryRecord,
  upsertCustomerRecord,
  upsertEmployeeRecord,
  upsertItemRecord,
  upsertReceiptRecord,
  upsertStoreRecord,
} from "@/lib/loyverse/records";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/encryption";
import { ensureBaselineCoa } from "@/lib/finance/baseline";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";
import { jobLog } from "@/worker/log";

// Re-exported for existing consumers/tests; the implementation moved to
// lib/loyverse/records.ts so webhook handlers share the identical mapping.
export { parseLoyverseDate };

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

  // Step 11 — post-sync setup checklist: baseline chart of accounts + default
  // GL mappings (#10) so the next issue's auto-posting has accounts to post
  // into. Idempotent — existing accounts/mappings are never overwritten.
  const baseline = await ensureBaselineCoa(orgId);
  jobLog(jobId, "sync complete", { counts, baselineAccounts: baseline.accounts });
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
      await upsertStoreRecord(c.orgId, store);
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
        await upsertCategoryRecord(c.orgId, category);
      }
      return { main: items.length };
    },
  );
  // Second pass: link parents now that every category in the run exists.
  for (const items of pages) {
    for (const category of items) {
      await linkCategoryParent(c.orgId, category);
    }
  }
}

// --- items + variants ----------------------------------------------------------

async function syncItems(c: ResourceContext): Promise<void> {
  await forEachPage(c, "/items", { updated_at_min: c.since }, async (items) => {
    let pageVariants = 0;
    for (const item of items) {
      pageVariants += await upsertItemRecord(c.orgId, item);
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
        await upsertEmployeeRecord(c.orgId, employee);
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
        await upsertCustomerRecord(c.orgId, customer);
      }
      return { main: items.length };
    },
  );
}

// --- receipts + refunds -------------------------------------------------------------

async function syncReceipts(c: ResourceContext): Promise<void> {
  await forEachPage(
    c,
    "/receipts",
    { created_at_min: c.since },
    async (items) => {
      let upserted = 0;
      let pageRefunds = 0;
      for (const receipt of items) {
        const result = await upsertReceiptRecord(c.orgId, receipt);
        if (!result.ok) {
          if (result.reason === "unknown-store") {
            jobLog(c.jobId, "receipt skipped: unknown store", {
              receiptId: typeof receipt.id === "string" ? receipt.id : null,
            });
          }
          continue;
        }
        upserted += 1;
        pageRefunds += result.refunds;
      }
      return { main: upserted, extra: { refunds: pageRefunds } };
    },
  );
}
