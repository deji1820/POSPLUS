"use server";

import { revalidatePath } from "next/cache";

import { requireModule } from "@/lib/auth/guard";
import { AuthContextError } from "@/lib/auth/session-context";
import { prisma } from "@/lib/db";
import { ConnectError, connectLoyverse } from "@/lib/loyverse/connect";
import { enqueueLoyverseSync, QueueUnavailableError } from "@/lib/queue/enqueue";

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
    const run = await prisma.syncRun.create({
      data: { organizationId: ctx.orgId, type: "MANUAL", status: "QUEUED" },
    });
    try {
      await enqueueLoyverseSync({ syncRunId: run.id, organizationId: ctx.orgId, type: "MANUAL" });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        await prisma.syncRun.update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            errorSummary: "Could not schedule the sync: job queue unavailable.",
          },
        });
        return { ok: false, message: "The job queue is unavailable. Try again shortly." };
      }
      throw error;
    }
    revalidatePath("/settings/loyverse");
    return { ok: true, message: "Sync queued." };
  } catch (error) {
    return toState(error);
  }
}
