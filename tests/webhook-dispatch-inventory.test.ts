/**
 * `inventory_levels.*` webhook dispatch (issue #16): snapshots apply INLINE
 * during dispatch as ADJUSTMENT movements — the absolute-truth reconciliation
 * path for stock changed outside POSPLUS. The dispatch result reports the
 * applied/unchanged/skipped breakdown in its note (surfaced in the audit row
 * by the webhook processor) and dedupe keys embed the stored event id so
 * replays skip instead of double-applying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyInventoryLevelSnapshot: vi.fn(),
}));

vi.mock("@/lib/inventory/projection", () => ({
  applyInventoryLevelSnapshot: mocks.applyInventoryLevelSnapshot,
}));

import { dispatchWebhookEvent } from "@/lib/loyverse/webhook/handlers";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyInventoryLevelSnapshot.mockResolvedValue({ status: "applied" });
});

describe("dispatchWebhookEvent — inventory_levels", () => {
  it("applies each level inline with an event-scoped dedupe key", async () => {
    const result = await dispatchWebhookEvent({
      organizationId: "org-1",
      eventType: "inventory_levels.update",
      webhookEventId: "evt-100",
      payload: {
        inventory_levels: [
          { variant_id: "lv-var-1", store_id: "seed-store-1", in_stock: 7 },
          { variant_id: "lv-var-2", store_id: "seed-store-1", in_stock: 0 },
        ],
      },
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.resource).toBe("inventory_levels");
    expect(result.records).toBe(2);
    expect(mocks.applyInventoryLevelSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.applyInventoryLevelSnapshot).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        variantLoyverseId: "lv-var-1",
        storeLoyverseId: "seed-store-1",
        dedupeKey: "snapshot:evt-100:lv-var-1:seed-store-1",
      }),
    );
  });

  it("reports applied/unchanged/skipped in the note", async () => {
    mocks.applyInventoryLevelSnapshot
      .mockResolvedValueOnce({ status: "applied" })
      .mockResolvedValueOnce({ status: "noChange" })
      .mockResolvedValueOnce({ status: "skipped", reason: "unknown-variant" });

    const result = await dispatchWebhookEvent({
      organizationId: "org-1",
      eventType: "inventory_levels.update",
      webhookEventId: "evt-100",
      payload: {
        inventory_levels: [
          { variant_id: "lv-var-1", store_id: "seed-store-1", in_stock: 7 },
          { variant_id: "lv-var-2", store_id: "seed-store-1", in_stock: 7 },
          { variant_id: "lv-var-3", store_id: "seed-store-1", in_stock: 7 },
          { store_id: "seed-store-1", in_stock: 7 }, // missing variant_id — structurally invalid
        ],
      },
    });

    expect(result.records).toBe(1);
    expect(result.note).toBe("inventory levels applied=1 unchanged=1 skipped=2");
    expect(mocks.applyInventoryLevelSnapshot).toHaveBeenCalledTimes(3);
  });

  it("accepts string quantities from Loyverse", async () => {
    await dispatchWebhookEvent({
      organizationId: "org-1",
      eventType: "inventory_levels.update",
      webhookEventId: "evt-100",
      payload: {
        inventory_levels: [{ variant_id: "lv-var-1", store_id: "seed-store-1", in_stock: "3.5" }],
      },
    });

    const input = mocks.applyInventoryLevelSnapshot.mock.calls[0][1] as { inStock: { toString(): string } };
    expect(input.inStock.toString()).toBe("3.5");
  });

  it("does not defer inventory_levels anymore", async () => {
    const result = await dispatchWebhookEvent({
      organizationId: "org-1",
      eventType: "inventory_levels.update",
      webhookEventId: "evt-100",
      payload: { inventory_levels: [] },
    });

    expect(result.status).toBe("PROCESSED");
    expect(result.note).not.toContain("deferred");
  });

  it("still ignores unsupported resources", async () => {
    const result = await dispatchWebhookEvent({
      organizationId: "org-1",
      eventType: "shifts.create",
      payload: { shifts: [{ id: "s-1" }] },
    });

    expect(result.status).toBe("IGNORED");
    expect(result.note).toContain("Unsupported webhook type");
  });
});
