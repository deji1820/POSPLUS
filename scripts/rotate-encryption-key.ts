/**
 * Encryption-key rotation walkthrough (SPEC.md §18, issue #34).
 *
 * After a deployment rotates ENCRYPTION_KEY/KEY_VERSION (old key retired into
 * ENCRYPTION_KEYS so old envelopes still decrypt), run this script to
 * RE-ENCRYPT stored Loyverse credentials onto the current key. Envelopes are
 * self-describing (`<version>:<iv>:<tag>:<ct>`), so rows already on the
 * current version are skipped and rows on retired versions are decrypted
 * with the retired key, re-encrypted with the current key, and updated.
 *
 * Usage:
 *   # dry-run: report what would rotate
 *   pnpm tsx scripts/rotate-encryption-key.ts --dry-run
 *   # apply
 *   pnpm tsx scripts/rotate-encryption-key.ts
 *
 * Env (same as the app): DATABASE_URL, ENCRYPTION_KEY, KEY_VERSION,
 * ENCRYPTION_KEYS (JSON map of retired versions).
 *
 * Exit codes: 0 = all rows on current key (or N rotated cleanly);
 *             1 = at least one row failed (reported, left untouched).
 */
import { prisma } from "@/lib/db";
import {
  currentKeyVersion,
  decryptSecret,
  encryptSecret,
} from "@/lib/encryption";

function envelopeVersion(envelope: string): string {
  return envelope.split(":")[0] ?? "unknown";
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const targetVersion = currentKeyVersion();
  console.log(`[rotate] current key version: ${targetVersion}${dryRun ? " (dry-run)" : ""}`);

  try {
    const connections = await prisma.loyverseConnection.findMany({
      select: { id: true, organizationId: true, encryptedApiKey: true },
    });

    let alreadyCurrent = 0;
    let rotated = 0;
    const failures: { id: string; organizationId: string; error: string }[] = [];

    for (const connection of connections) {
      const fromVersion = envelopeVersion(connection.encryptedApiKey);
      if (fromVersion === targetVersion) {
        alreadyCurrent += 1;
        continue;
      }
      try {
        const { plaintext } = decryptSecret(connection.encryptedApiKey);
        if (dryRun) {
          console.log(
            `[rotate] would re-encrypt connection ${connection.id} (org ${connection.organizationId}): ${fromVersion} → ${targetVersion}`,
          );
          rotated += 1;
          continue;
        }
        await prisma.loyverseConnection.update({
          where: { id: connection.id },
          data: { encryptedApiKey: encryptSecret(plaintext), updatedAt: new Date() },
        });
        console.log(
          `[rotate] re-encrypted connection ${connection.id} (org ${connection.organizationId}): ${fromVersion} → ${targetVersion}`,
        );
        rotated += 1;
      } catch (error) {
        failures.push({
          id: connection.id,
          organizationId: connection.organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(
      `[rotate] done: ${rotated} rotated, ${alreadyCurrent} already on ${targetVersion}, ${failures.length} failed of ${connections.length} connections.`,
    );
    for (const failure of failures) {
      console.error(
        `[rotate] FAILED connection ${failure.id} (org ${failure.organizationId}): ${failure.error}`,
      );
    }
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[rotate] fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
