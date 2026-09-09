/**
 * Webhook → organization attribution (SPEC.md §9/§18). The signature proves
 * the payload came from Loyverse; attribution decides WHICH organization it
 * belongs to without trusting anything the body claims beyond that:
 *
 *  1. `merchant_id` → LoyverseConnection.merchantId (captured at connect, #9)
 *  2. `store_id`(s) in the payload → Store.loyverseStoreId (synced by #7)
 *  3. exactly one connected organization in the deployment → that org
 *
 * Returns null when the event belongs to a business this deployment does not
 * serve — the caller acks and drops it (there is no org to attach the
 * immutable event to, and 4xx would make Loyverse retry forever).
 */
import { prisma } from "@/lib/db";

function collectStoreIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const top = payload.store_id;
  if (typeof top === "string" && top) ids.push(top);
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          const storeId = (entry as Record<string, unknown>).store_id;
          if (typeof storeId === "string" && storeId) ids.push(storeId);
        }
      }
    }
  }
  return [...new Set(ids)];
}

export async function resolveWebhookOrganization(
  payload: Record<string, unknown>,
): Promise<string | null> {
  const merchantId = payload.merchant_id;
  if (typeof merchantId === "string" && merchantId) {
    const byMerchant = await prisma.loyverseConnection.findFirst({
      where: { merchantId },
      select: { organizationId: true },
    });
    if (byMerchant) return byMerchant.organizationId;
  }

  const storeIds = collectStoreIds(payload);
  if (storeIds.length > 0) {
    const byStore = await prisma.store.findFirst({
      where: { loyverseStoreId: { in: storeIds } },
      select: { organizationId: true },
    });
    if (byStore) return byStore.organizationId;
  }

  // Single-tenant deployments: one connection total is unambiguous.
  const connections = await prisma.loyverseConnection.findMany({
    select: { organizationId: true },
    take: 2,
  });
  if (connections.length === 1) return connections[0].organizationId;

  return null;
}
