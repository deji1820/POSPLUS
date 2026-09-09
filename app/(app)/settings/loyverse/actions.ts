"use server";

import { revalidatePath } from "next/cache";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { prisma } from "@/lib/db";
import { ConnectError, connectLoyverse } from "@/lib/loyverse/connect";

export interface LoyverseActionState {
  ok: boolean;
  message?: string;
}

function toState(error: unknown): LoyverseActionState {
  if (error instanceof AuthContextError || error instanceof ConnectError) {
    return { ok: false, message: error.message };
  }
  throw error;
}

export async function connectLoyverseAction(
  _prev: LoyverseActionState,
  formData: FormData,
): Promise<LoyverseActionState> {
  try {
    const ctx = await requireModule("SETTINGS");
    const apiKey = String(formData.get("apiKey") ?? "");
    await connectLoyverse(ctx.orgId, apiKey);
    revalidatePath("/settings/loyverse");
    return { ok: true, message: "Connected. Initial sync queued." };
  } catch (error) {
    return toState(error);
  }
}

export async function syncNowAction(
  _prev: LoyverseActionState,
  _formData: FormData,
): Promise<LoyverseActionState> {
  try {
    const ctx = await requireModule("SETTINGS");
    const connection = await prisma.loyverseConnection.findUnique({
      where: { organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!connection) {
      return { ok: false, message: "Connect a Loyverse API key first." };
    }
    await prisma.syncRun.create({
      data: { organizationId: ctx.orgId, type: "MANUAL", status: "QUEUED" },
    });
    revalidatePath("/settings/loyverse");
    return { ok: true, message: "Sync queued." };
  } catch (error) {
    return toState(error);
  }
}
