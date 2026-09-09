/**
 * Sanitized Loyverse status read-model for the settings page and the
 * GET /api/loyverse/sync/status endpoint (SPEC.md §6/§7). Everything here is
 * safe for operators: no credentials, no stack traces, provider errors only
 * as an operator-safe summary string.
 */
import { prisma } from "@/lib/db";

const RECENT_RUN_LIMIT = 10;

export interface SanitizedSyncRun {
  id: string;
  type: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorSummary: string | null;
}

export interface LoyverseStatus {
  connected: boolean;
  status: string;
  keyVersion: string | null;
  lastSyncAt: Date | null;
  lastWebhook: { eventType: string; status: string; receivedAt: Date } | null;
  recentRuns: SanitizedSyncRun[];
}

export async function getLoyverseStatus(organizationId: string): Promise<LoyverseStatus> {
  const [connection, runs, lastWebhook] = await Promise.all([
    prisma.loyverseConnection.findUnique({ where: { organizationId } }),
    prisma.syncRun.findMany({
      where: { organizationId },
      orderBy: { startedAt: "desc" },
      take: RECENT_RUN_LIMIT,
      select: {
        id: true,
        type: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        errorSummary: true,
      },
    }),
    prisma.webhookEvent.findFirst({
      where: { organizationId },
      orderBy: { receivedAt: "desc" },
      select: { eventType: true, status: true, receivedAt: true },
    }),
  ]);

  return {
    connected: connection !== null,
    status: connection?.status ?? "disconnected",
    keyVersion: connection?.keyVersion ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    lastWebhook: lastWebhook ?? null,
    recentRuns: runs,
  };
}
