/**
 * Loyverse connection use-cases (SPEC.md §6 "Loyverse Connection", §7, §18).
 * Shared by the API routes and the settings page server actions so both
 * entry points enforce identical behavior:
 *   - the API key is validated against Loyverse before it is stored,
 *   - only the encrypted envelope is persisted (never the plaintext),
 *   - responses are sanitized — the stored key is never returned,
 *   - an INITIAL sync run is recorded as QUEUED; the worker that consumes it
 *     lands with #6 (BullMQ) / #7 (initial sync).
 */
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/encryption";
import { validateApiKey } from "@/lib/loyverse/client";

export class ConnectError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** Shape safe to return to the browser — never includes encryptedApiKey. */
export interface SanitizedConnection {
  id: string;
  organizationId: string;
  status: string;
  keyVersion: string;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function sanitizeConnection(
  connection: Omit<SanitizedConnection, never> & { encryptedApiKey?: string },
): SanitizedConnection {
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    status: connection.status,
    keyVersion: connection.keyVersion,
    lastSyncAt: connection.lastSyncAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Validate + store a Loyverse API key for an organization.
 * Throws ConnectError with an operator-safe §19 envelope code on failure.
 */
export async function connectLoyverse(
  organizationId: string,
  rawApiKey: string,
): Promise<SanitizedConnection> {
  const apiKey = rawApiKey.trim();
  if (!apiKey) {
    throw new ConnectError(400, "VALIDATION_ERROR", "API key is required.");
  }
  if (apiKey.length > 200) {
    throw new ConnectError(400, "VALIDATION_ERROR", "API key is too long.");
  }

  const check = await validateApiKey(apiKey);
  if (!check.ok) {
    if (check.reason === "invalid") {
      throw new ConnectError(
        400,
        "INVALID_LOYVERSE_API_KEY",
        "Loyverse rejected this API key. Check the key and try again.",
      );
    }
    throw new ConnectError(
      502,
      "LOYVERSE_UNAVAILABLE",
      "Could not reach Loyverse to validate the key. Try again shortly.",
    );
  }

  // Encrypt before touching the DB; the plaintext never appears in any query.
  const envelope = encryptSecret(apiKey);
  const keyVersion = envelope.slice(0, envelope.indexOf(":"));

  const [connection] = await prisma.$transaction([
    prisma.loyverseConnection.upsert({
      where: { organizationId },
      create: {
        organizationId,
        encryptedApiKey: envelope,
        keyVersion,
        status: "connected",
      },
      update: {
        encryptedApiKey: envelope,
        keyVersion,
        status: "connected",
      },
    }),
    prisma.syncRun.create({
      data: {
        organizationId,
        type: "INITIAL",
        status: "QUEUED",
      },
    }),
  ]);

  return sanitizeConnection(connection);
}
