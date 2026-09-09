"use server";

import { revalidatePath } from "next/cache";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { FinanceError } from "@/lib/finance/errors";
import { reverseEntry } from "@/lib/finance/ledger";

export interface ReversalActionState {
  ok: boolean;
  message?: string;
  reversalEntryId?: string;
}

function toState(error: unknown): ReversalActionState {
  if (error instanceof AuthContextError || error instanceof FinanceError) {
    return { ok: false, message: error.message };
  }
  throw error;
}

/**
 * Reversal workflow (SPEC.md §6 "/finance/ledger", §8 invariants): creates a
 * NEW linked reversing entry — posted entries are never mutated or deleted,
 * so the ledger page intentionally exposes no edit/delete affordances.
 */
export async function reverseEntryAction(
  _prev: ReversalActionState,
  formData: FormData,
): Promise<ReversalActionState> {
  try {
    const ctx = await requireModule("FINANCE");
    const id = String(formData.get("id") ?? "");
    const result = await reverseEntry(
      ctx.orgId,
      id,
      { reason: String(formData.get("reason") ?? "") },
      ctx.userId,
    );
    revalidatePath("/finance/ledger");
    revalidatePath(`/finance/ledger/${id}`);
    revalidatePath(`/finance/ledger/${result.reversalEntryId}`);
    return { ok: true, message: "Reversal posted.", reversalEntryId: result.reversalEntryId };
  } catch (error) {
    return toState(error);
  }
}
