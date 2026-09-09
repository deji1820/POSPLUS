import type { SyncRun } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransientJobError } from "@/lib/queue/errors";
import {
  defaultSyncEngine,
  processLoyverseSyncJob,
  type SyncEngine,
} from "@/worker/processors/loyverse-sync";

const mocks = vi.hoisted(() => ({
  syncRunFindUnique: vi.fn(),
  syncRunUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    syncRun: {
      findUnique: mocks.syncRunFindUnique,
      update: mocks.syncRunUpdate,
    },
  },
}));

const RUN: SyncRun = {
  id: "run-1",
  organizationId: "org-1",
  type: "MANUAL",
  startedAt: new Date("2026-09-09T00:00:00Z"),
  finishedAt: null,
  status: "QUEUED",
  counts: null,
  errorSummary: null,
};

function fakeJob(data: { syncRunId: string; organizationId: string }) {
  return { id: "job-1", data } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processLoyverseSyncJob (SyncRun lifecycle, SPEC.md §9/§19)", () => {
  it("dead-letters permanently when the run does not exist", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(null);
    await expect(
      processLoyverseSyncJob(fakeJob({ syncRunId: "missing", organizationId: "org-1" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.syncRunUpdate).not.toHaveBeenCalled();
  });

  it("dead-letters permanently on an organization mismatch (cross-tenant job data)", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(RUN);
    await expect(
      processLoyverseSyncJob(fakeJob({ syncRunId: "run-1", organizationId: "org-evil" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mocks.syncRunUpdate).not.toHaveBeenCalled();
  });

  it("runs QUEUED → RUNNING → FAILED with a safe summary for the #6 stub engine", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(RUN);
    await processLoyverseSyncJob(
      fakeJob({ syncRunId: "run-1", organizationId: "org-1" }),
      defaultSyncEngine,
    );

    const statuses = mocks.syncRunUpdate.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toEqual(["RUNNING", "FAILED"]);
    const final = mocks.syncRunUpdate.mock.calls.at(-1)![0].data;
    expect(final.errorSummary).toContain("Sync engine not yet available");
    expect(final.finishedAt).toBeInstanceOf(Date);
    // Permanent (recorded) failure must NOT be rethrown — no pointless retries.
  });

  it("records the run FAILED and rethrows transient errors so BullMQ retries", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(RUN);
    const flaky: SyncEngine = async () => {
      throw new TransientJobError("Loyverse API timeout");
    };
    await expect(
      processLoyverseSyncJob(
        fakeJob({ syncRunId: "run-1", organizationId: "org-1" }),
        flaky,
      ),
    ).rejects.toThrow("Loyverse API timeout");

    const final = mocks.syncRunUpdate.mock.calls.at(-1)![0].data;
    expect(final.status).toBe("FAILED");
    expect(final.errorSummary).toBe("Loyverse API timeout");
  });

  it("marks the run COMPLETED with engine counts on success", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(RUN);
    const engine: SyncEngine = async () => ({ counts: { items: 12, receipts: 340 } });
    await processLoyverseSyncJob(
      fakeJob({ syncRunId: "run-1", organizationId: "org-1" }),
      engine,
    );

    const final = mocks.syncRunUpdate.mock.calls.at(-1)![0].data;
    expect(final.status).toBe("COMPLETED");
    expect(final.counts).toEqual({ items: 12, receipts: 340 });
    expect(final.errorSummary).toBeNull();
  });

  it("redacts internal error text from the operator-facing summary", async () => {
    mocks.syncRunFindUnique.mockResolvedValue(RUN);
    const leaky: SyncEngine = async () => {
      // Single-line SQL-ish driver error: must NOT reach the summary (§19).
      throw new Error("column encrypted_api_key does not exist");
    };
    await processLoyverseSyncJob(
      fakeJob({ syncRunId: "run-1", organizationId: "org-1" }),
      leaky,
    ).catch(() => {});
    // Rethrown for retry, but the recorded summary must be safe.
    const final = mocks.syncRunUpdate.mock.calls.at(-1)![0].data;
    expect(final.errorSummary).toBe("Unexpected worker error. Retry the job or contact support.");
  });
});
