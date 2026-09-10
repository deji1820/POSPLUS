/**
 * Central audit writer (SPEC.md §17), used by ALL modules.
 *
 * Every audited event is one AuditLog row: actor, action, entity, optional
 * before/after JSON, metadata, and request context (ip / user agent). The
 * writer is deliberately boring:
 *
 *   - it NEVER throws — an audit failure must not break the business flow
 *     it observes (it is logged server-side instead);
 *   - it accepts a transaction client so writers inside a $transaction
 *     commit atomically with the change they describe;
 *   - it carries NO secrets — callers must put only sanitized state into
 *     the json fields (no credentials, tokens, or raw webhook bodies;
 *     §18/§24: prefer event IDs and sanitized metadata).
 *
 * Coverage this sprint (issue #15): auth login/logout/failure, integration
 * credential changes, sync runs, webhook verification outcome, journal
 * posting/reversal. Settings events (organization, store, warehouse,
 * membership/scope, payroll rules, dashboard preferences) register with #37.
 * Later sprints add PO, inventory, BOM, production, and document events —
 * they register new actions in AUDIT_ACTIONS and call writeAudit the same
 * way.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/** Stable action strings, grouped by domain. Add new domains here. */
export const AUDIT_ACTIONS = {
  AUTH: {
    LOGIN: "auth.login",
    LOGIN_FAILED: "auth.login_failed",
    LOGOUT: "auth.logout",
  },
  INTEGRATION: {
    CONNECTED: "integration.connected",
  },
  SYNC: {
    STARTED: "sync.started",
    COMPLETED: "sync.completed",
    FAILED: "sync.failed",
  },
  WEBHOOK: {
    ACCEPTED: "webhook.accepted",
    DUPLICATE: "webhook.duplicate",
    VERIFICATION_FAILED: "webhook.verification_failed",
    ENQUEUE_FAILED: "webhook.enqueue_failed",
    PROCESSED: "webhook.processed",
    IGNORED: "webhook.ignored",
    FAILED: "webhook.failed",
  },
  JOURNAL: {
    POSTED: "journal.posted",
    REVERSED: "journal.reversed",
  },
  SETTINGS: {
    ORGANIZATION_UPDATED: "organization.updated",
    STORE_CREATED: "store.created",
    STORE_UPDATED: "store.updated",
    WAREHOUSE_CREATED: "warehouse.created",
    WAREHOUSE_UPDATED: "warehouse.updated",
    MEMBERSHIP_CREATED: "membership.created",
    MEMBERSHIP_ROLE_CHANGED: "membership.role_changed",
    MEMBERSHIP_STATUS_CHANGED: "membership.status_changed",
    MEMBERSHIP_STORE_SCOPE_CHANGED: "membership.store_scope_changed",
    MEMBERSHIP_WAREHOUSE_SCOPE_CHANGED: "membership.warehouse_scope_changed",
    PAYROLL_DEDUCTION_CREATED: "payroll.deduction_created",
    PAYROLL_DEDUCTION_UPDATED: "payroll.deduction_updated",
    PAYROLL_PERIOD_CREATED: "payroll.period_created",
    DASHBOARD_PREFERENCE_SAVED: "dashboard.preference_saved",
  },
  DOCUMENTS: {
    REQUESTED: "document.requested",
    GENERATED: "document.generated",
    GENERATION_FAILED: "document.generation_failed",
  },
  /** Nightly maintenance findings (#33) — system-driven, actor always null. */
  MAINTENANCE: {
    STALE_SYNC_RUN: "maintenance.stale_sync_run",
    STALE_WEBHOOK: "maintenance.stale_webhook",
    RECONCILIATION_MISMATCH: "maintenance.reconciliation_mismatch",
  },
} as const;

export interface AuditEntryInput {
  organizationId: string;
  /** Null for worker/system-driven events (webhooks, syncs, auto-posting). */
  actorUserId?: string | null;
  /** One of AUDIT_ACTIONS (free-form allowed for forward-compat, but prefer the catalog). */
  action: string;
  entityType: string;
  entityId: string;
  /** Sanitized state only — never secrets or raw provider payloads. */
  beforeJson?: Prisma.InputJsonValue | null;
  afterJson?: Prisma.InputJsonValue | null;
  metadataJson?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Transaction clients and the plain client both satisfy this pick. */
type AuditExecutor = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * Write one audit row. Never rejects: a failure here is logged with the
 * action/entity for operator follow-up, and the observed flow continues
 * unaffected.
 */
export async function writeAudit(
  entry: AuditEntryInput,
  executor: AuditExecutor = prisma,
): Promise<void> {
  try {
    await executor.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        beforeJson: entry.beforeJson ?? undefined,
        afterJson: entry.afterJson ?? undefined,
        metadataJson: entry.metadataJson ?? undefined,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (error) {
    logger.error("audit write failed", {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Auth-event helper: resolve the user's organization (first ACTIVE
 * membership) and record the event with the user as actor. Auth events are
 * best-effort — failures stay out of the sign-in path.
 */
export async function writeUserAuthAudit(
  userId: string,
  action: string,
  metadata: Prisma.InputJsonValue = {},
): Promise<void> {
  try {
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true },
    });
    if (!membership) return; // user with no org has nothing to audit against
    await writeAudit({
      organizationId: membership.organizationId,
      actorUserId: userId,
      action,
      entityType: "User",
      entityId: userId,
      metadataJson: metadata,
    });
  } catch (error) {
    logger.error("auth audit write failed", {
      action,
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
