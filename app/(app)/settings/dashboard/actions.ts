"use server";

import {
  toSettingsState,
  type SettingsActionState,
} from "@/lib/settings";
import { requireModule } from "@/lib/auth/guard";
import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { revalidatePath } from "next/cache";
import {
  dashboardPreferenceSchema,
  saveDashboardPreference,
} from "@/lib/settings/dashboard-preferences";

/** Save the current user's dashboard context preference. */
export async function saveDashboardPreferenceAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireModule("SETTINGS");
    const parsed = dashboardPreferenceSchema.parse({
      mode: formData.get("mode"),
      scope: formData.get("scope"),
      period: formData.get("period"),
    });
    const after = await saveDashboardPreference(ctx.orgId, ctx.userId, parsed);
    await writeAudit({
      organizationId: ctx.orgId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.SETTINGS.DASHBOARD_PREFERENCE_SAVED,
      entityType: "DashboardPreference",
      entityId: ctx.userId,
      afterJson: { ...after },
    });
    revalidatePath("/settings/dashboard");
    return { ok: true, message: "Dashboard preference saved." };
  } catch (error) {
    return toSettingsState(error);
  }
}

export type { SettingsActionState };
