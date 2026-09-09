"use server";

import { revalidatePath } from "next/cache";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { createAccount, updateAccount } from "@/lib/finance/accounts";
import { FinanceError } from "@/lib/finance/errors";

export interface FinanceActionState {
  ok: boolean;
  message?: string;
}

function toState(error: unknown): FinanceActionState {
  if (error instanceof AuthContextError || error instanceof FinanceError) {
    return { ok: false, message: error.message };
  }
  throw error;
}

function optionalStoreId(formData: FormData): string | null {
  const value = String(formData.get("storeId") ?? "").trim();
  return value === "" ? null : value;
}

export async function createAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const ctx = await requireModule("FINANCE");
    await createAccount(ctx.orgId, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? ""),
      storeId: optionalStoreId(formData),
    });
    revalidatePath("/finance/accounts");
    return { ok: true, message: "Account created." };
  } catch (error) {
    return toState(error);
  }
}

export async function updateAccountAction(
  _prev: FinanceActionState,
  formData: FormData,
): Promise<FinanceActionState> {
  try {
    const ctx = await requireModule("FINANCE");
    const id = String(formData.get("id") ?? "");
    await updateAccount(ctx.orgId, id, {
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? ""),
      active: formData.get("active") === "on",
      storeId: optionalStoreId(formData),
    });
    revalidatePath("/finance/accounts");
    return { ok: true, message: "Account updated." };
  } catch (error) {
    return toState(error);
  }
}
