/**
 * Audit log read model (SPEC.md §17, issue #15).
 *
 * Org-scoped by construction; newest first; cursor-paginated. Filters:
 * action / entityType / entityId / actorUserId / from-to window. Bad filter
 * input is a 400 VALIDATION_ERROR (§19 envelope code), never a 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditLogFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { auditLog: { findMany: mocks.auditLogFindMany } },
}));

import { FinanceError } from "@/lib/finance/errors";
import { listAuditEntries } from "@/lib/audit/list";

const ROW = (id: string, createdAt: string) => ({
  id,
  organizationId: "org-1",
  actorUserId: "user-1",
  action: "journal.posted",
  entityType: "JournalEntry",
  entityId: "je-1",
  beforeJson: null,
  afterJson: { journalEntryId: "je-1" },
  metadataJson: null,
  ipAddress: null,
  userAgent: null,
  createdAt: new Date(createdAt),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAuditEntries", () => {
  it("scopes to the org, orders newest first, and maps rows to ISO summaries", async () => {
    mocks.auditLogFindMany.mockResolvedValue([ROW("a2", "2026-09-01T00:00:01Z")]);

    const result = await listAuditEntries("org-1", {});

    expect(mocks.auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].createdAt).toBe("2026-09-01T00:00:01.000Z");
    expect(result.entries[0].afterJson).toEqual({ journalEntryId: "je-1" });
    expect(result.nextCursor).toBeNull();
  });

  it("applies action/entity/actor and from-to filters", async () => {
    mocks.auditLogFindMany.mockResolvedValue([]);

    await listAuditEntries("org-1", {
      action: "webhook.duplicate",
      entityType: "WebhookEvent",
      entityId: "evt-1",
      actorUserId: "user-1",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
    });

    const { where } = mocks.auditLogFindMany.mock.calls[0][0];
    expect(where).toEqual({
      organizationId: "org-1",
      action: "webhook.duplicate",
      entityType: "WebhookEvent",
      entityId: "evt-1",
      actorUserId: "user-1",
      createdAt: {
        gte: new Date("2026-09-01T00:00:00Z"),
        lte: new Date("2026-09-02T00:00:00Z"),
      },
    });
  });

  it("pages with limit+1 and returns a cursor only when a further page exists", async () => {
    mocks.auditLogFindMany.mockResolvedValue([
      ROW("a3", "2026-09-01T00:00:03Z"),
      ROW("a2", "2026-09-01T00:00:02Z"),
      ROW("a1", "2026-09-01T00:00:01Z"),
    ]);

    const first = await listAuditEntries("org-1", { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(["a3", "a2"]);
    expect(first.nextCursor).toBe("a2");

    // Second page: cursor + skip 1, honoring the caller's limit.
    mocks.auditLogFindMany.mockResolvedValue([ROW("a1", "2026-09-01T00:00:01Z")]);
    const second = await listAuditEntries("org-1", { limit: 2, cursor: "a2" });
    expect(mocks.auditLogFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: "a2" }, skip: 1, take: 3 }),
    );
    expect(second.entries.map((e) => e.id)).toEqual(["a1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects out-of-range limits and malformed datetimes with 400 VALIDATION_ERROR", async () => {
    mocks.auditLogFindMany.mockResolvedValue([]);

    await expect(listAuditEntries("org-1", { limit: 0 })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    await expect(listAuditEntries("org-1", { limit: 500 })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
    await expect(
      listAuditEntries("org-1", { from: "not-a-date" }),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(mocks.auditLogFindMany).not.toHaveBeenCalled();
  });

  it("throws FinanceError so routes render the §19 envelope", async () => {
    mocks.auditLogFindMany.mockResolvedValue([]);
    const error = await listAuditEntries("org-1", { limit: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(FinanceError);
  });
});
