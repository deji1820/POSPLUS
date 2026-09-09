/**
 * Server-side secret encryption per SPEC.md §18 ("Secrets"):
 *   - AES-256-GCM with a random IV per encryption.
 *   - Key material comes from deployment env, never the database.
 *   - Versioned-key rotation: the key version is embedded in the envelope,
 *     so decrypting older records keeps working after rotation.
 *
 * Env:
 *   ENCRYPTION_KEY   32-byte key, base64 (44 chars) or hex (64 chars).
 *   KEY_VERSION      current version label, e.g. "v1" (default "v1").
 *   ENCRYPTION_KEYS  optional JSON map of retired versions for decryption:
 *                    '{"v1":"<base64-or-hex>"}' while KEY_VERSION=v2.
 *
 * Envelope format (self-describing, URL-safe):
 *   <version>:<iv b64>:<authTag b64>:<ciphertext b64>
 *
 * Plaintext is never logged, never leaves this module unencrypted, and the
 * stored envelope reveals neither the key nor the plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class EncryptionConfigurationError extends Error {
  readonly code = "ENCRYPTION_MISCONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigurationError";
  }
}

export class DecryptionError extends Error {
  readonly code = "DECRYPTION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

const GCM_IV_LENGTH = 12;
const KEY_LENGTH = 32;

interface KeyRing {
  current: { version: string; key: Buffer };
  /** All known versions, including retired ones (for decryption). */
  byVersion: ReadonlyMap<string, Buffer>;
}

let cachedKeyRing: KeyRing | null = null;

function decodeKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = Buffer.from(trimmed, "base64");
    } catch {
      throw new EncryptionConfigurationError(`${source} is not valid base64 or hex`);
    }
  }
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionConfigurationError(
      `${source} must decode to ${KEY_LENGTH} bytes (got ${key.length})`,
    );
  }
  return key;
}

function loadKeyRing(): KeyRing {
  if (cachedKeyRing) return cachedKeyRing;

  const currentVersion = process.env.KEY_VERSION?.trim() || "v1";
  const currentRaw = process.env.ENCRYPTION_KEY;
  if (!currentRaw) {
    throw new EncryptionConfigurationError(
      "ENCRYPTION_KEY is not set — Loyverse credentials cannot be encrypted",
    );
  }

  const byVersion = new Map<string, Buffer>();
  byVersion.set(currentVersion, decodeKey(currentRaw, "ENCRYPTION_KEY"));

  const retiredJson = process.env.ENCRYPTION_KEYS;
  if (retiredJson) {
    let retired: Record<string, string>;
    try {
      retired = JSON.parse(retiredJson) as Record<string, string>;
    } catch {
      throw new EncryptionConfigurationError("ENCRYPTION_KEYS is not valid JSON");
    }
    for (const [version, raw] of Object.entries(retired)) {
      if (!byVersion.has(version)) {
        byVersion.set(version, decodeKey(raw, `ENCRYPTION_KEYS["${version}"]`));
      }
    }
  }

  cachedKeyRing = {
    current: { version: currentVersion, key: byVersion.get(currentVersion)! },
    byVersion,
  };
  return cachedKeyRing;
}

/** Test/dev hook: drop the memoized key ring so env changes take effect. */
export function resetKeyRingForTests(): void {
  cachedKeyRing = null;
}

/** Current key version label (stored on records for rotation tracking). */
export function currentKeyVersion(): string {
  return loadKeyRing().current.version;
}

/** Encrypt plaintext; returns the self-describing versioned envelope. */
export function encryptSecret(plaintext: string): string {
  const { version, key } = loadKeyRing().current;
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

export interface DecryptedSecret {
  plaintext: string;
  keyVersion: string;
}

/** Decrypt an envelope produced by encryptSecret. */
export function decryptSecret(envelope: string): DecryptedSecret {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new DecryptionError("Malformed envelope");
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  const key = loadKeyRing().byVersion.get(version);
  if (!key) {
    throw new DecryptionError(`Unknown key version "${version}"`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return { plaintext, keyVersion: version };
  } catch {
    throw new DecryptionError("Decryption failed (wrong key, tampered data, or bad envelope)");
  }
}
