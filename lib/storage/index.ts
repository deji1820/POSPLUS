/**
 * S3-compatible object storage client (SPEC.md §20, issue #32).
 *
 * Documents are generated server-side and uploaded here — never local disk.
 * Works against AWS S3 or any S3-compatible store (Cloudflare R2, MinIO):
 *   - S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *   - S3_FORCE_PATH_STYLE: "true" (default when an endpoint is set — MinIO/R2
 *     need path-style addressing) or "false" for virtual-hosted AWS buckets.
 *
 * §18/§24: credentials come from the environment only and are never logged
 * or returned to callers; the browser talks to our authenticated download
 * endpoint, never to this store.
 */
import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

export class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageConfig {
  bucket: string;
  client: S3Client;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new StorageError(500, "STORAGE_MISCONFIGURED", `${name} is not configured.`);
  }
  return value;
}

let cached: StorageConfig | null = null;

/** Lazy singleton — importing this module never opens a network connection. */
export function getStorage(): StorageConfig {
  if (cached) return cached;
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE
    ? process.env.S3_FORCE_PATH_STYLE === "true"
    : Boolean(endpoint);
  const client = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY"),
    },
  });
  cached = { bucket: requiredEnv("S3_BUCKET"), client };
  return cached;
}

/** Test hook: drop the cached client so the next call re-reads the environment. */
export function resetStorageForTests(): void {
  cached = null;
}

export interface StoredObject {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength: number;
}

/**
 * Upload one generated document. The SHA-256 checksum travels with the row
 * (§20) so a download can be verified end-to-end.
 */
export async function putDocument(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ checksum: string }> {
  const { bucket, client } = getStorage();
  const checksum = createHash("sha256").update(body).digest("hex");
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
      }),
    );
  } catch (error) {
    throw toStorageError(error);
  }
  return { checksum };
}

/** Fetch one stored object for the authenticated download endpoint. */
export async function getDocument(key: string): Promise<StoredObject> {
  const { bucket, client } = getStorage();
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) throw new StorageError(404, "NOT_FOUND", "Document object is missing.");
    return {
      body: out.Body as NodeJS.ReadableStream,
      contentType: out.ContentType ?? "application/octet-stream",
      contentLength: out.ContentLength ?? 0,
    };
  } catch (error) {
    throw toStorageError(error);
  }
}

function toStorageError(error: unknown): StorageError {
  if (error instanceof NoSuchKey) {
    return new StorageError(404, "NOT_FOUND", "The stored document object was not found.");
  }
  if (error instanceof S3ServiceException && error.name === "NotFound") {
    return new StorageError(404, "NOT_FOUND", "The stored document object was not found.");
  }
  if (error instanceof StorageError) return error;
  // §19/§24: operator-safe message only — no SDK internals to the caller.
  return new StorageError(502, "STORAGE_UNAVAILABLE", "Object storage is unavailable.");
}
