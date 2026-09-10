/**
 * Dashboard preferences use-cases (SPEC.md §6 Management Dashboard Modes).
 * A per-user, per-org saved context (Stores vs Commissary mode, scope, and
 * period) so the management dashboard opens with the operator's last view.
 * Org + user scoped; the row is keyed to the current user.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";

export const dashboardPreferenceSchema = z.object({
  mode: z.enum(["stores", "commissary"]),
  /** Scope descriptor: a store/commissary id, or empty/blank for "all". */
  scope: z.string().trim().max(100).optional().or(z.literal("").transform(() => undefined)),
  /** Period preset: this_week | this_month | custom. */
  period: z.string().trim().max(50).optional().or(z.literal("").transform(() => undefined)),
});
export type DashboardPreferenceInput = z.infer<typeof dashboardPreferenceSchema>;

export interface DashboardPreferenceSummary {
  mode: string | null;
  scope: string | null;
  period: string | null;
}

/**
 * Extract a display scalar from a Json column that stores either a plain
 * string or a single-key wrapper ({value}/{preset}).
 */
function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "object" && v !== null) {
    const inner = (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).preset;
    return typeof inner === "string" && inner.length > 0 ? inner : null;
  }
  return null;
}

/** Read the current user's preference for this org (null fields when unset). */
export async function getDashboardPreference(
  orgId: string,
  userId: string,
): Promise<DashboardPreferenceSummary> {
  const row = await prisma.dashboardPreference.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { mode: true, scope: true, period: true },
  });
  return {
    mode: (row?.mode as string | null) ?? null,
    scope: scalar(row?.scope),
    period: scalar(row?.period),
  };
}

/** Upsert the current user's preference (validated scalar prefs). */
export async function saveDashboardPreference(
  orgId: string,
  userId: string,
  input: DashboardPreferenceInput,
): Promise<DashboardPreferenceSummary> {
  const row = await prisma.dashboardPreference.upsert({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    create: {
      organizationId: orgId,
      userId,
      mode: input.mode,
      scope: input.scope ? { value: input.scope } : undefined,
      period: input.period ? { preset: input.period } : undefined,
    },
    update: {
      mode: input.mode,
      scope: input.scope ? { value: input.scope } : { value: "" },
      period: input.period ? { preset: input.period } : { preset: "" },
    },
    select: { mode: true, scope: true, period: true },
  });
  return {
    mode: (row.mode as string | null) ?? null,
    scope: scalar(row.scope),
    period: scalar(row.period),
  };
}
