"use server";

import { z } from "zod";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { ReorderError } from "@/lib/reorder/errors";
import {
  acceptSuggestion,
  dismissSuggestion,
} from "@/lib/reorder/suggestions";
import {
  type ReorderActionState,
} from "@/lib/reorder/state";
import { revalidatePath } from "next/cache";

export type { ReorderActionState } from "@/lib/reorder/state";

/** Convert known errors into a user-safe action state; rethrow the rest. */
function toReorderState(error: unknown): ReorderActionState {
  if (
    error instanceof AuthContextError ||
    error instanceof ReorderError
  ) {
    return { ok: false, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { ok: false, message: error.issues[0]?.message ?? "Invalid input." };
  }
  throw error;
}

const acceptSchema = z.object({
  suggestionId: z.string().min(1, "Suggestion is required."),
  supplierId: z.string().min(1, "Choose a supplier."),
});

/**
 * Accept a reorder suggestion → Draft PurchaseOrder (SPEC.md §12, issue #17).
 * Gated by the PURCHASING module because it writes PurchaseOrder rows; the
 * role list is identical to INVENTORY today (§5), so this matches the page
 * gate in practice. The PO stays DRAFT — submitting it into the §13
 * approval flow is issue #18.
 */
export async function acceptSuggestionAction(
  _prev: ReorderActionState,
  formData: FormData,
): Promise<ReorderActionState> {
  try {
    const ctx = await requireModule("PURCHASING");
    const data = acceptSchema.parse({
      suggestionId: formData.get("suggestionId"),
      supplierId: formData.get("supplierId"),
    });
    const result = await acceptSuggestion(ctx.orgId, ctx.userId, data);
    revalidatePath("/supply-chain/reorder");
    return {
      ok: true,
      message: `Purchase order ${result.purchaseOrderNumber} created as a draft.`,
    };
  } catch (error) {
    return toReorderState(error);
  }
}

/** Dismiss a reorder suggestion (SPEC.md §12, issue #17). */
export async function dismissSuggestionAction(
  _prev: ReorderActionState,
  formData: FormData,
): Promise<ReorderActionState> {
  try {
    const ctx = await requireModule("INVENTORY");
    const suggestionId = z.string().min(1).parse(formData.get("suggestionId"));
    await dismissSuggestion(ctx.orgId, ctx.userId, suggestionId);
    revalidatePath("/supply-chain/reorder");
    return { ok: true, message: "Suggestion dismissed." };
  } catch (error) {
    return toReorderState(error);
  }
}
