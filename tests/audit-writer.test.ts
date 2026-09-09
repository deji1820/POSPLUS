/**
 * Central audit writer (SPEC.md §17, issue #15).
 *
 * Contract under test:
 *   - one AuditLog row per call with org, actor, action, entity, optional
 *     before/after/metadata JSON, and request context (ip / user agent);
 *   - the writer NEVER throws — a failing audit write is logged server-side
 *     and the observed business flow continues;
 *   - it accepts a transaction client so in-transaction audits commit
 *     atomically with the change they describe;
 *   - writeUserAuthAudit resolves the user's organization from the first
 *     ACTIVE membership and attributes the user as actor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditLogCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: mocks.auditLogCreate },
    organizationMembership: { findFirst: mocks.membershipFindFirst },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));

import { AUDIT_ACTIONS, writeAudit, writeUserAuthAudit } from "@/lib/audit/writer";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("writeAudit", () => {
  it("creates one row with org, actor, action, entity, json fields, and request context", async () => {
    mocks.auditLogCreate.mockResolvedValue({ id: "a-1" });

    await writeAudit({
      organizationId: "org-1",
      actorUserId: "user-1",
      action: AUDIT_ACTIONS.JOURNAL.POSTED,
      entityType: "JournalEntry",
      entityId: "je-1",
      beforeJson: { status: "draft" },
      afterJson: { status: "posted" },
      metadataJson: { source: "receipt" },
      ipAddress: "203.0.113.7",
      userAgent: "loyverse-hook/1.0",
    });

    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        actorUserId: "user-1",
        action: "journal.posted",
        entityType: "JournalEntry",
        entityId: "je-1",
        beforeJson: { status: "draft" },
        afterJson: { status: "posted" },
        metadataJson: { source: "receipt" },
        ipAddress: "203.0.113.7",
        userAgent: "loyverse-hook/1.0",
      },
    });
  });

  it("defaults actor/ip/userAgent to null and omits absent json fields", async () => {
    mocks.auditLogCreate.mockResolvedValue({ id: "a-2" });

    await writeAudit({
      organizationId: "org-1",
      action: AUDIT_ACTIONS.SYNC.STARTED,
      entityType: "SyncRun",
      entityId: "run-1",
    });

    const { data } = mocks.auditLogCreate.mock.calls[0][0];
    expect(data.actorUserId).toBeNull();
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    // Absent json fields are passed as undefined (Prisma treats them as unset).
    expect(data.beforeJson).toBeUndefined();
    expect(data.afterJson).toBeUndefined();
    expect(data.metadataJson).toBeUndefined();
  });

  it("never throws when the create fails — it logs and returns", async () => {
    mocks.auditLogCreate.mockRejectedValue(new Error("db down"));

    await expect(
      writeAudit({
        organizationId: "org-1",
        action: AUDIT_ACTIONS.WEBHOOK.ACCEPTED,
        entityType: "WebhookEvent",
        entityId: "evt-1",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "audit write failed",
      expect.objectContaining({ action: "webhook.accepted", entityId: "evt-1" }),
    );
  });

  it("uses the provided transaction executor so the row commits with the change", async () => {
    const txCreate = vi.fn().mockResolvedValue({ id: "a-3" });
    const tx = { auditLog: { create: txCreate } };

    await writeAudit(
      {
        organizationId: "org-1",
        action: AUDIT_ACTIONS.JOURNAL.REVERSED,
        entityType: "JournalEntry",
        entityId: "je-9",
      },
      tx as never,
    );

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("writeUserAuthAudit", () => {
  it("resolves the first ACTIVE membership and attributes the user as actor", async () => {
    mocks.membershipFindFirst.mockResolvedValue({ organizationId: "org-9" });
    mocks.auditLogCreate.mockResolvedValue({ id: "a-4" });

    await writeUserAuthAudit("user-2", AUDIT_ACTIONS.AUTH.LOGIN, { email: "a@b.c" });

    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-2", status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-9",
        actorUserId: "user-2",
        action: "auth.login",
        entityType: "User",
        entityId: "user-2",
        metadataJson: { email: "a@b.c" },
      }),
    });
  });

  it("writes nothing when the user has no ACTIVE membership", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await writeUserAuthAudit("user-3", AUDIT_ACTIONS.AUTH.LOGOUT);

    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("never throws when membership resolution fails", async () => {
    mocks.membershipFindFirst.mockRejectedValue(new Error("db down"));

    await expect(
      writeUserAuthAudit("user-4", AUDIT_ACTIONS.AUTH.LOGIN_FAILED),
    ).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "auth audit write failed",
      expect.objectContaining({ action: "auth.login_failed", userId: "user-4" }),
    );
  });
});
