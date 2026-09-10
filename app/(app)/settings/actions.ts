"use server";

import {
  runSettingsMutation,
  toSettingsState,
  type SettingsActionState,
} from "@/lib/settings";
import {
  updateOrganization,
  updateOrganizationSchema,
} from "@/lib/settings/organization";
import {
  createStore,
  storeInputSchema,
  updateStore,
  updateStoreSchema,
} from "@/lib/settings/stores";
import { AUDIT_ACTIONS } from "@/lib/audit/writer";
import {
  createWarehouse,
  updateWarehouse,
  updateWarehouseSchema,
  warehouseInputSchema,
} from "@/lib/settings/warehouses";

/** Update the organization's core config (name / currency / timezone). */
export async function updateOrganizationAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        name: formData.get("name"),
        currency: formData.get("currency"),
        timezone: formData.get("timezone"),
      },
      updateOrganizationSchema,
      async (ctx, data) => {
        const { before, after } = await updateOrganization(ctx.orgId, data);
        return {
          message: "Organization updated.",
          revalidate: ["/settings/organization"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.ORGANIZATION_UPDATED,
            entityType: "Organization",
            entityId: ctx.orgId,
            beforeJson: before,
            afterJson: after,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Create a new store. */
export async function createStoreAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        name: formData.get("name"),
        address: formData.get("address"),
        timezone: formData.get("timezone"),
        loyverseStoreId: formData.get("loyverseStoreId"),
        active: formData.get("active") === "on" || formData.get("active") === "true",
      },
      storeInputSchema,
      async (ctx, data) => {
        const created = await createStore(ctx.orgId, data);
        return {
          message: `Store "${created.name}" created.`,
          revalidate: ["/settings/stores"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.STORE_CREATED,
            entityType: "Store",
            entityId: created.id,
            afterJson: created,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Update an existing store. */
export async function updateStoreAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        id: formData.get("id"),
        name: formData.get("name"),
        address: formData.get("address"),
        timezone: formData.get("timezone"),
        loyverseStoreId: formData.get("loyverseStoreId"),
        active: formData.get("active") === "on" || formData.get("active") === "true",
      },
      updateStoreSchema,
      async (ctx, data) => {
        const { before, after } = await updateStore(ctx.orgId, data);
        return {
          message: `Store "${after.name}" updated.`,
          revalidate: ["/settings/stores"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.STORE_UPDATED,
            entityType: "Store",
            entityId: after.id,
            beforeJson: before,
            afterJson: after,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Create a new warehouse (post-sync checklist: warehouses/locations). */
export async function createWarehouseAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        name: formData.get("name"),
        code: formData.get("code"),
        storeId: formData.get("storeId"),
        active: formData.get("active") === "on" || formData.get("active") === "true",
      },
      warehouseInputSchema,
      async (ctx, data) => {
        const created = await createWarehouse(ctx.orgId, data);
        return {
          message: `Warehouse "${created.name}" created.`,
          revalidate: ["/settings/warehouses"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.WAREHOUSE_CREATED,
            entityType: "Warehouse",
            entityId: created.id,
            afterJson: created,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

/** Update an existing warehouse. */
export async function updateWarehouseAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    return await runSettingsMutation(
      {
        id: formData.get("id"),
        name: formData.get("name"),
        code: formData.get("code"),
        storeId: formData.get("storeId"),
        active: formData.get("active") === "on" || formData.get("active") === "true",
      },
      updateWarehouseSchema,
      async (ctx, data) => {
        const { before, after } = await updateWarehouse(ctx.orgId, data);
        return {
          message: `Warehouse "${after.name}" updated.`,
          revalidate: ["/settings/warehouses"],
          audit: {
            action: AUDIT_ACTIONS.SETTINGS.WAREHOUSE_UPDATED,
            entityType: "Warehouse",
            entityId: after.id,
            beforeJson: before,
            afterJson: after,
          },
        };
      },
    );
  } catch (error) {
    return toSettingsState(error);
  }
}

export type { SettingsActionState };
