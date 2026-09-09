/**
 * Outbound Loyverse stock write-back (issue #16, SPEC.md §8 "recorded with
 * external request/response metadata, no secrets stored").
 *
 * Loyverse stock is ABSOLUTE: `POST /inventory` sets each level to the given
 * `stock_after` value (not a delta). Each write-back is a StockWritebackRequest
 * row created PENDING with a sanitized request payload (ids + quantity only),
 * delivered by the `write-back-stock` job, then stamped SUCCEEDED/FAILED with
 * the response status/body or a safe error. The API key is decrypted in
 * memory only and never touches the row, the logs, or the payload (§24).
 *
 * Triggers (PO receiving, transfers, manual counts) land with later issues;
 * this issue delivers the recorded delivery pipeline.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/encryption";
import { InventoryError } from "@/lib/inventory/errors";
import { loyverseApiBase } from "@/lib/loyverse/client";
import { getQueue, JOB_QUEUES } from "@/lib/queue/queues";
import { QueueUnavailableError } from "@/lib/queue/enqueue";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";

const WRITE_BACK_TIMEOUT_MS = 30_000;

export interface StockWritebackInput {
  organizationId: string;
  variantId: string;
  /** Absolute stock level to set at the store (Loyverse stock_after). */
  quantity: Prisma.Decimal;
  reason: string;
  storeId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  actorId?: string | null;
}

/**
 * Record a PENDING write-back and schedule its delivery. The stored request
 * payload is sanitized — variant/store ids and the quantity, never secrets.
 */
export async function enqueueStockWriteback(input: StockWritebackInput): Promise<{ id: string }> {
  const request = await prisma.stockWritebackRequest.create({
    data: {
      organizationId: input.organizationId,
      variantId: input.variantId,
      storeId: input.storeId ?? null,
      quantity: input.quantity,
      reason: input.reason,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      status: "PENDING",
      requestPayload: {
        variantId: input.variantId,
        storeId: input.storeId ?? null,
        quantity: input.quantity.toString(),
        reason: input.reason,
      } satisfies Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const queue = getQueue(JOB_QUEUES["write-back-stock"]);
  try {
    await queue.add(
      "write-back-stock",
      { stockWritebackRequestId: request.id, organizationId: input.organizationId },
      { jobId: `writeback-${request.id}` },
    );
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
  return request;
}

/** Resolve the Loyverse ids a write-back needs; config gaps are permanent. */
async function resolveLoyverseTarget(orgId: string, request: {
  variantId: string;
  storeId: string | null;
}): Promise<{ variantLoyverseId: string; storeLoyverseId: string }> {
  const variant = await prisma.variant.findFirst({
    where: { id: request.variantId, organizationId: orgId },
    select: { loyverseId: true },
  });
  if (!variant?.loyverseId) {
    throw new InventoryError(
      400,
      "VARIANT_NOT_SYNCED",
      "The variant is not synced to Loyverse yet; run a sync before writing stock back.",
    );
  }
  let storeLoyverseId: string | null = null;
  if (request.storeId) {
    const store = await prisma.store.findFirst({
      where: { id: request.storeId, organizationId: orgId },
      select: { loyverseStoreId: true },
    });
    storeLoyverseId = store?.loyverseStoreId ?? null;
  }
  if (!storeLoyverseId) {
    // Fall back to the org's primary store — Loyverse requires a store per level.
    const store = await prisma.store.findFirst({
      where: { organizationId: orgId },
      orderBy: { createdAt: "asc" },
      select: { loyverseStoreId: true },
    });
    storeLoyverseId = store?.loyverseStoreId ?? null;
  }
  if (!storeLoyverseId) {
    throw new InventoryError(
      400,
      "STORE_NOT_SYNCED",
      "No synced Loyverse store is available for the stock write-back.",
    );
  }
  return { variantLoyverseId: variant.loyverseId, storeLoyverseId };
}

/**
 * Deliver one PENDING/SUCCEEDED write-back to Loyverse and record the outcome.
 * Idempotent in the request sense: Loyverse stock is absolute, so a retry of
 * the same request sets the same level. Rethrows TransientJobError for
 * network/429/5xx (BullMQ retry) and UnrecoverableError for a revoked key.
 */
export async function performStockWriteback(
  stockWritebackRequestId: string,
  organizationId: string,
): Promise<{ status: "SUCCEEDED" | "FAILED" }> {
  const request = await prisma.stockWritebackRequest.findFirst({
    where: { id: stockWritebackRequestId, organizationId },
  });
  if (!request) {
    throw new UnrecoverableError(`Stock write-back request ${stockWritebackRequestId} was not found.`);
  }

  const connection = await prisma.loyverseConnection.findUnique({
    where: { organizationId },
    select: { encryptedApiKey: true },
  });
  if (!connection) {
    throw new UnrecoverableError("No Loyverse connection exists for this organization.");
  }
  const apiKey = decryptSecret(connection.encryptedApiKey).plaintext; // memory only — never persisted (§24)

  const { variantLoyverseId, storeLoyverseId } = await resolveLoyverseTarget(organizationId, request);
  const quantity = new Prisma.Decimal(request.quantity as number | string | Prisma.Decimal);

  let response: Response;
  try {
    response = await fetch(`${loyverseApiBase()}/inventory`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inventory_levels: [
          { variant_id: variantLoyverseId, store_id: storeLoyverseId, stock_after: quantity.toNumber() },
        ],
      }),
      signal: AbortSignal.timeout(WRITE_BACK_TIMEOUT_MS),
    });
  } catch {
    await prisma.stockWritebackRequest.update({
      where: { id: request.id },
      data: { status: "FAILED", error: "Loyverse did not respond.", completedAt: new Date() },
    });
    throw new TransientJobError("Loyverse did not respond; the write-back will be retried.");
  }

  if (response.status === 401 || response.status === 403) {
    await prisma.stockWritebackRequest.update({
      where: { id: request.id },
      data: {
        status: "FAILED",
        responseStatus: response.status,
        error: "Loyverse rejected the stored API key.",
        completedAt: new Date(),
      },
    });
    throw new UnrecoverableError("Loyverse rejected the stored API key. Reconnect Loyverse in Settings.");
  }

  let responseBody: Prisma.InputJsonValue | null = null;
  try {
    const parsed = (await response.json()) as unknown;
    responseBody = JSON.parse(JSON.stringify(parsed)) as Prisma.InputJsonValue;
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    await prisma.stockWritebackRequest.update({
      where: { id: request.id },
      data: {
        status: "FAILED",
        responseStatus: response.status,
        ...(responseBody !== null ? { responseBody } : {}),
        error: `Loyverse request failed (HTTP ${response.status}).`,
        completedAt: new Date(),
      },
    });
    if (response.status === 429 || response.status >= 500) {
      throw new TransientJobError(`Loyverse is rate limiting or unavailable (HTTP ${response.status}).`);
    }
    throw new UnrecoverableError(`Loyverse rejected the stock write-back (HTTP ${response.status}).`);
  }

  await prisma.stockWritebackRequest.update({
    where: { id: request.id },
    data: {
      status: "SUCCEEDED",
      responseStatus: response.status,
      ...(responseBody !== null ? { responseBody } : {}),
      error: null,
      completedAt: new Date(),
    },
  });
  return { status: "SUCCEEDED" };
}
