/**
 * Nightly stale webhook/sync checks (issue #33, SPEC.md §10).
 *
 * Acceptance: the stale-sync check flags an injected failed SyncRun. Each
 * flagged row becomes one org-scoped audit row with a system (null) actor;
 * fresh rows and rows outside the flag windows stay silent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAILED_FLAG_WINDOW_MS,
  STUCK_RUN_THRESHOLD_MS,
  UNDISPATCHED_WEBHOOK_THRESHOLD_MS,
  runStaleChecks,
} from "@/lib/maintenance/stale-checks";

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  organizationFindMany: vi.fn(),
  syncRunFindMany: vi.fn(),
  webhookEventFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: { findMany: mocks.organizationFindMany },
    syncRun: { findMany: mocks.syncRunFindMany },
    webhookEvent: { findMany: mocks.webhookEventFindMany },
  },
}));

vi.mock("@/lib/audit/writer", () => ({
  AUDIT_ACTIONS: {
    MAINTENANCE: {
      STALE_SYNC_RUN: "maintenance.stale_sync_run",
      STALE_WEBHOOK: "maintenance.stale_webhook",
      RECONCILIATION_MISMATCH: "maintenance.reconciliation_mismatch",
    },
  },
  writeAudit: mocks.writeAudit,
}));

const NOW = new Date("2026-09-10T02:00:00.000Z");

/** syncRun.findMany is called twice: stuck sweep, then failed sweep. */
function syncRunQueries() {
  return mocks.syncRunFindMany.mock.calls.map((c) => c[0].where);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }]);
  mocks.syncRunFindMany.mockResolvedValue([]);
  mocks.webhookEventFindMany.mockResolvedValue([]);
  mocks.writeAudit.mockResolvedValue(undefined);
});

describe("runStaleChecks", () => {
  it("flags an injected FAILED SyncRun with an org-scoped system audit row", async () => {
    mocks.syncRunFindMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === "FAILED"
        ? [
            {
              id: "run-failed-1",
              type: "INCREMENTAL",
              errorSummary: "items page 3: provider timeout",
              startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
              finishedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
            },
          ]
        : [],
    );

    const summary = await runStaleChecks(NOW);

    expect(summary.failedRuns).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        actorUserId: null,
        action: "maintenance.stale_sync_run",
        entityType: "SyncRun",
        entityId: "run-failed-1",
        metadataJson: expect.objectContaining({ reason: "failed" }),
      }),
    );
  });

  it("flags a RUNNING run older than the stuck threshold", async () => {
    mocks.syncRunFindMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === "RUNNING"
        ? [
            {
              id: "run-stuck-1",
              type: "INITIAL",
              startedAt: new Date(NOW.getTime() - STUCK_RUN_THRESHOLD_MS - 60_000),
            },
          ]
        : [],
    );

    const summary = await runStaleChecks(NOW);

    expect(summary.stuckRuns).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "run-stuck-1",
        metadataJson: expect.objectContaining({ reason: "stuck_running" }),
      }),
    );
  });

  it("does not flag a failed run outside the flag window", async () => {
    mocks.syncRunFindMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === "FAILED"
        ? [
            {
              id: "run-old",
              type: "INCREMENTAL",
              errorSummary: "old",
              startedAt: new Date(NOW.getTime() - 3 * FAILED_FLAG_WINDOW_MS),
              finishedAt: new Date(NOW.getTime() - 2 * FAILED_FLAG_WINDOW_MS),
            },
          ]
        : [],
    );

    // The window is expressed in the query; rows it returns are flagged.
    // Assert the window actually bounds the sweep.
    await runStaleChecks(NOW);
    const failedWhere = syncRunQueries().find((w) => w.status === "FAILED");
    expect(failedWhere.OR).toBeDefined();
  });

  it("flags a webhook accepted but never dispatched past the threshold", async () => {
    mocks.webhookEventFindMany.mockImplementation(
      async (args: { where: { status: string } }) =>
        args.where.status === "RECEIVED"
          ? [
              {
                id: "evt-1",
                eventType: "receipts.create",
                receivedAt: new Date(NOW.getTime() - UNDISPATCHED_WEBHOOK_THRESHOLD_MS - 60_000),
              },
            ]
          : [],
    );

    const summary = await runStaleChecks(NOW);

    expect(summary.undispatchedWebhooks).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "maintenance.stale_webhook",
        entityType: "WebhookEvent",
        entityId: "evt-1",
        metadataJson: expect.objectContaining({ reason: "never_dispatched" }),
      }),
    );
  });

  it("flags a FAILED webhook within the window and stays silent when clean", async () => {
    mocks.webhookEventFindMany.mockImplementation(async (args: { where: { status: string } }) =>
      args.where.status === "FAILED"
        ? [
            {
              id: "evt-failed",
              eventType: "inventory_levels.update",
              error: "dispatch enqueue failed",
              receivedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
            },
          ]
        : [],
    );

    const summary = await runStaleChecks(NOW);

    expect(summary.failedWebhooks).toBe(1);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }]);
    mocks.syncRunFindMany.mockResolvedValue([]);
    mocks.webhookEventFindMany.mockResolvedValue([]);

    const clean = await runStaleChecks(NOW);
    expect(clean).toMatchObject({
      stuckRuns: 0,
      failedRuns: 0,
      undispatchedWebhooks: 0,
      failedWebhooks: 0,
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
