/**
 * Audit log read model (SPEC.md §17) — the queryable side of the writer.
 * Powers the settings audit-log view (#37) and ops/acceptance checks now.
 *
 * Org-scoped by construction; newest first; cursor-paginated (createdAt+id)
 * so the view can page deep logs without offset churn.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { FinanceError } from "@/lib/finance/errors";

export const auditListFilterSchema = z.object({
  action: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditListFilters = z.infer<typeof auditListFilterSchema>;

export interface AuditEntrySummary {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  metadataJson: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string; // ISO
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Filtered, org-scoped audit entries, newest first. */
export async function listAuditEntries(
  orgId: string,
  rawFilters: unknown,
): Promise<{ entries: AuditEntrySummary[]; nextCursor: string | null }> {
  const parsed = auditListFilterSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Invalid audit filter parameters.");
  }
  const filters = parsed.data;
  const from = parseDate(filters.from);
  const to = parseDate(filters.to);
  if ((filters.from && !from) || (filters.to && !to)) {
    throw new FinanceError(400, "VALIDATION_ERROR", "Invalid audit filter parameters.");
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      organizationId: orgId,
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filters.limit + 1,
    ...(filters.cursor
      ? {
          cursor: { id: filters.cursor },
          skip: 1,
        }
      : {}),
  });

  const page = rows.slice(0, filters.limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeJson: row.beforeJson,
      afterJson: row.afterJson,
      metadataJson: row.metadataJson,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > filters.limit ? page[page.length - 1].id : null,
  };
}
