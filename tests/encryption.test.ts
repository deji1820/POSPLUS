import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptSecret,
  DecryptionError,
  EncryptionConfigurationError,
  encryptSecret,
  currentKeyVersion,
  resetKeyRingForTests,
} from "@/lib/encryption";

const V1_KEY = Buffer.alloc(32, 1).toString("base64");
const V2_KEY = Buffer.alloc(32, 2).toString("base64");

function setEnv(key: string | undefined, version: string, retired?: string) {
  if (key === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = key;
  }
  process.env.KEY_VERSION = version;
  if (retired === undefined) {
    delete process.env.ENCRYPTION_KEYS;
  } else {
    process.env.ENCRYPTION_KEYS = retired;
  }
  resetKeyRingForTests();
}

describe("encryption", () => {
  beforeEach(() => setEnv(V1_KEY, "v1"));
  afterEach(() => {
    setEnv(undefined, "v1");
  });

  it("round-trips a secret and records the key version", () => {
    const envelope = encryptSecret("loyverse-key-abc123");
    expect(decryptSecret(envelope)).toEqual({
      plaintext: "loyverse-key-abc123",
      keyVersion: "v1",
    });
  });

  it("produces a self-describing envelope: version:iv:tag:ciphertext", () => {
    const envelope = encryptSecret("secret");
    const parts = envelope.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // IV (12 bytes) and GCM tag (16 bytes) in base64.
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
    // The envelope must not contain the plaintext.
    expect(envelope).not.toContain("secret");
  });

  it("uses a random IV per encryption", () => {
    expect(encryptSecret("same-input")).not.toBe(encryptSecret("same-input"));
  });

  it("accepts a hex-encoded key", () => {
    setEnv(Buffer.alloc(32, 7).toString("hex"), "v1");
    const envelope = encryptSecret("hex-key-works");
    expect(decryptSecret(envelope).plaintext).toBe("hex-key-works");
  });

  it("fails decryption with the wrong key", () => {
    const envelope = encryptSecret("top-secret");
    setEnv(V2_KEY, "v2");
    expect(() => decryptSecret(envelope)).toThrow(DecryptionError);
  });

  it("detects tampered ciphertext", () => {
    const envelope = encryptSecret("top-secret");
    const [version, iv, tag, ct] = envelope.split(":");
    const tampered = Buffer.from(ct, "base64");
    tampered[0] = tampered[0] ^ 0xff;
    expect(() => decryptSecret([version, iv, tag, tampered.toString("base64")].join(":"))).toThrow(
      DecryptionError,
    );
  });

  it("decrypts retired versions via ENCRYPTION_KEYS after rotation", () => {
    const legacy = encryptSecret("old-key-material");
    setEnv(V2_KEY, "v2", JSON.stringify({ v1: V1_KEY }));
    // Old envelope still decrypts with the retired v1 key…
    expect(decryptSecret(legacy)).toEqual({ plaintext: "old-key-material", keyVersion: "v1" });
    // …while new envelopes use v2.
    expect(currentKeyVersion()).toBe("v2");
    const fresh = encryptSecret("new-key-material");
    expect(decryptSecret(fresh).keyVersion).toBe("v2");
    expect(() => decryptSecret(fresh)).not.toThrow();
  });

  it("fails on an unknown key version", () => {
    const envelope = encryptSecret("x");
    setEnv(V2_KEY, "v2"); // no retired keys configured
    expect(() => decryptSecret(envelope)).toThrow(/Unknown key version/);
  });

  it("throws a clear error when ENCRYPTION_KEY is missing", () => {
    setEnv(undefined, "v1");
    expect(() => encryptSecret("x")).toThrow(EncryptionConfigurationError);
  });

  it("throws a clear error when the key has the wrong length", () => {
    setEnv(Buffer.alloc(16, 1).toString("base64"), "v1");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("throws on a malformed envelope", () => {
    expect(() => decryptSecret("v1:only-two-parts")).toThrow(DecryptionError);
  });
});
