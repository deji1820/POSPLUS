"use server";

import { revalidatePath } from "next/cache";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { FinanceError } from "@/lib/finance/errors";
import { replaceMappings } from "@/lib/finance/mappings";

export interface MappingsActionState {
  ok: boolean;
  message?: string;
}

export async function saveMappingsAction(
  _prev: MappingsActionState,
  formData: FormData,
): Promise<MappingsActionState> {
  try {
    const ctx = await requireModule("FINANCE");
    const mappings: Array<{ paymentType?: string; categoryId?: string; accountId: string }> = [];
    for (const [key, value] of formData.entries()) {
      const accountId = String(value).trim();
      if (!accountId) continue; // empty select = leave unmapped
      if (key.startsWith("payment:")) {
        mappings.push({ paymentType: key.slice("payment:".length), accountId });
      } else if (key.startsWith("category:")) {
        mappings.push({ categoryId: key.slice("category:".length), accountId });
      }
    }
    await replaceMappings(ctx.orgId, { mappings });
    revalidatePath("/finance/mappings");
    return { ok: true, message: "Mappings saved." };
  } catch (error) {
    if (error instanceof AuthContextError || error instanceof FinanceError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}
