"use server";

import {
  runSettingsMutation,
  toSettingsState,
  type SettingsActionState,
} from "@/lib/settings";
import {
  changeRole,
  changeRoleSchema,
  inviteUser,
  inviteUserSchema,
  setMembershipStatus,
  setMembershipStatusSchema,
  setStoreScope,
  setStoreScopeSchema,
  setWarehouseScope,
  setWarehouseScopeSchema,
} from "@/lib/settings/members";
import { AUDIT_ACTIONS } from "@/lib/audit/writer";

/** Link a user (by email) into the org with a role. */
export async function inviteUserAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      { email: formData.get("email"), role: formData.get("role") },
      inviteUserSchema,
      async (ctx, data) => {
        const created = await inviteUser(ctx.orgId, data);
        return {
          message: `Added ${created.email} as ${created.role}.`,
          revalidate: ["/settings/roles"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.MEMBERSHIP_CREATED,
            entityType: "OrganizationMembership",
            entityId: created.id,
            afterJson: { email: created.email, role: created.role },
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Change a member's role. */
export async function changeRoleAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      { membershipId: formData.get("membershipId"), role: formData.get("role") },
      changeRoleSchema,
      async (ctx, data) => {
        const { before, after } = await changeRole(ctx.orgId, data);
        return {
          message: `${after.email} is now ${after.role}.`,
          revalidate: ["/settings/roles"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.MEMBERSHIP_ROLE_CHANGED,
            entityType: "OrganizationMembership",
            entityId: after.id,
            beforeJson: { role: before.role },
            afterJson: { role: after.role, email: after.email },
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Activate or deactivate a membership. */
export async function setMembershipStatusAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      { membershipId: formData.get("membershipId"), status: formData.get("status") },
      setMembershipStatusSchema,
      async (ctx, data) => {
        const { before, after } = await setMembershipStatus(ctx.orgId, data);
        return {
          message:
            after.status === "ACTIVE"
              ? `${after.email} reactivated.`
              : `${after.email} deactivated.`,
          revalidate: ["/settings/roles"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.MEMBERSHIP_STATUS_CHANGED,
            entityType: "OrganizationMembership",
            entityId: after.id,
            beforeJson: { status: before.status },
            afterJson: { status: after.status, email: after.email },
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Replace a store-scoped member's store access (empty = unrestricted). */
export async function setStoreScopeAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const storeIds = formData.getAll("storeIds").map(String).filter(Boolean);
    return await runSettingsMutation(
      { membershipId: formData.get("membershipId"), storeIds },
      setStoreScopeSchema,
      async (ctx, data) => {
        const result = await setStoreScope(ctx.orgId, data);
        return {
          message:
            result.storeIds.length === 0
              ? "Store scope cleared (unrestricted)."
              : `Store scope set to ${result.storeIds.length} store(s).`,
          revalidate: ["/settings/roles"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.MEMBERSHIP_STORE_SCOPE_CHANGED,
            entityType: "OrganizationMembership",
            entityId: data.membershipId,
            afterJson: { storeIds: result.storeIds },
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Replace a warehouse-scoped member's warehouse access (empty = unrestricted). */
export async function setWarehouseScopeAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const warehouseIds = formData.getAll("warehouseIds").map(String).filter(Boolean);
    return await runSettingsMutation(
      { membershipId: formData.get("membershipId"), warehouseIds },
      setWarehouseScopeSchema,
      async (ctx, data) => {
        const result = await setWarehouseScope(ctx.orgId, data);
        return {
          message:
            result.warehouseIds.length === 0
              ? "Warehouse scope cleared (unrestricted)."
              : `Warehouse scope set to ${result.warehouseIds.length} warehouse(s).`,
          revalidate: ["/settings/roles"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.MEMBERSHIP_WAREHOUSE_SCOPE_CHANGED,
            entityType: "OrganizationMembership",
            entityId: data.membershipId,
            afterJson: { warehouseIds: result.warehouseIds },
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

export type { SettingsActionState };
