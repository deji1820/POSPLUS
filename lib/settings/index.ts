/**
 * Settings domain shared helpers (SPEC.md §6 Settings, §17 Auditability).
 *
 * Every settings mutation runs through the same shape:
 *   1. `requireModule("SETTINGS")` — only OWNER may touch org config (#5/§18);
 *   2. validate input with zod (never trust the client);
 *   3. scope every query by `ctx.orgId` (tenant isolation);
 *   4. apply the change + write an AuditLog row atomically (§17 —
 *      "organization and role changes" are explicitly audited);
 *   5. `revalidatePath` so the server component re-renders.
 *
 * The action wrapper converts known errors (auth denial, validation, domain)
 * into a user-safe state and rethrows anything unexpected (so it surfaces in
 * the server log, never the client).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { writeAudit, type AuditEntryInput } from "@/lib/audit/writer";
import { requireModule } from "@/lib/auth/guard";
import { AuthContextError, type SessionContext } from "@/lib/auth/session-context";
import { SettingsError } from "@/lib/settings/errors";

import type { SettingsActionState } from "@/lib/settings/state";
export type { SettingsActionState } from "@/lib/settings/state";
export { initialSettingsState } from "@/lib/settings/state";

/** Convert known errors into a user-safe action state; rethrow the rest. */
export function toSettingsState(error: unknown): SettingsActionState {
  if (
    error instanceof AuthContextError ||
    error instanceof SettingsError
  ) {
    return { ok: false, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { ok: false, message: error.issues[0]?.message ?? "Invalid input." };
  }
  throw error;
}

/** Shape returned by a settings mutation callback. */
export interface MutationResult {
  /** Human-safe success note rendered by the form. */
  message: string;
  /**
   * Audit descriptor, minus org/actor (added by the helper). before/after
   * are plain serializable snapshots — accepted loosely here and narrowed to
   * Prisma's InputJsonValue at the writeAudit boundary.
   */
  audit:
    | (Omit<AuditEntryInput, "organizationId" | "actorUserId" | "beforeJson" | "afterJson" | "metadataJson"> & {
        beforeJson?: unknown;
        afterJson?: unknown;
        metadataJson?: unknown;
      })
    | null;
  /** Paths to revalidate on success. */
  revalidate?: string[];
}

/**
 * Run a guarded, validated settings mutation and write its audit row. The
 * `mutate` callback performs the DB change(s) and returns the result +
 * audit descriptor; the helper stamps org/actor onto the audit row. Audit
 * rows are written after the mutation succeeds — a failed change leaves no
 * misleading audit trail (§17 records what actually happened).
 */
export async function runSettingsMutation<T>(
  input: unknown,
  schema: z.ZodType<T>,
  mutate: (ctx: SessionContext, data: T) => Promise<MutationResult>,
): Promise<SettingsActionState> {
  const ctx = await requireModule("SETTINGS");
  const data = schema.parse(input);
  const result = await mutate(ctx, data);
  if (result.audit) {
    const { beforeJson, afterJson, metadataJson, ...rest } = result.audit;
    await writeAudit({
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      ...rest,
      beforeJson: beforeJson as AuditEntryInput["beforeJson"],
      afterJson: afterJson as AuditEntryInput["afterJson"],
      metadataJson: metadataJson as AuditEntryInput["metadataJson"],
    });
  }
  for (const path of result.revalidate ?? []) {
    revalidatePath(path);
  }
  return { ok: true, message: result.message };
}
