/**
 * Documents service (SPEC.md §20, issue #32) — the document pipeline:
 *
 *   request (API, user) → Document row PENDING → BullMQ job on `documents`
 *     queue → worker renders the PDF → upload to S3-compatible storage →
 *       row GENERATED with storage key + SHA-256 checksum → audited (§17)
 *
 * Storage credentials never leave the server; browsers use the
 * authenticated download endpoint, which streams through the app.
 */
import type { Document, Prisma } from "@prisma/client";

import { AUDIT_ACTIONS, writeAudit } from "@/lib/audit/writer";
import { prisma } from "@/lib/db";
import {
  buildDocumentPdf,
  DOCUMENT_JOB_NAMES,
  parseDocumentRequest,
  type DocumentEntityType,
} from "@/lib/documents/entities";
import { DocumentsError } from "@/lib/documents/errors";
import { getDocument, putDocument, StorageError } from "@/lib/storage";
import { enqueueGenerateDocumentPdf } from "@/lib/queue/enqueue";
import type { StoredObject } from "@/lib/storage";

const PDF_CONTENT_TYPE = "application/pdf";

export interface RequestedDocument {
  id: string;
  entityType: string;
  entityId: string | null;
  status: string;
}

/**
 * Create a PENDING Document and enqueue its render job. `roleModuleCheck`
 * is performed by the route via DOCUMENT_TYPE_MODULES before calling.
 */
export async function requestDocument(
  orgId: string,
  actorUserId: string,
  raw: unknown,
): Promise<RequestedDocument> {
  const { entityType, entityId, params } = parseDocumentRequest(raw);
  const row = await prisma.document.create({
    data: {
      organizationId: orgId,
      entityType,
      entityId,
      paramsJson: Object.keys(params).length > 0 ? (params as Prisma.InputJsonValue) : undefined,
      storageKey: "",
      contentType: PDF_CONTENT_TYPE,
      checksum: "",
    },
  });
  try {
    await enqueueGenerateDocumentPdf({
      jobName: DOCUMENT_JOB_NAMES[entityType],
      documentId: row.id,
      organizationId: orgId,
    });
  } catch (error) {
    // The row exists but nothing will consume it — mark it so rather than
    // leaving a permanent PENDING (mirrors the sync-run QUEUE_UNAVAILABLE
    // pattern in lib/queue/enqueue.ts).
    await prisma.document.update({ where: { id: row.id }, data: { status: "FAILED" } });
    throw error;
  }
  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: AUDIT_ACTIONS.DOCUMENTS.REQUESTED,
    entityType: "Document",
    entityId: row.id,
    afterJson: { entityType, entityId, status: "PENDING" },
  });
  return { id: row.id, entityType, entityId, status: row.status };
}

/**
 * Re-enqueue an existing document (retry after failure / refresh content).
 * Resets the row to PENDING and re-adds the render job — the BullMQ jobId
 * derives from the document id, so a duplicate enqueue is a no-op until the
 * previous job has drained from the queue.
 */
export async function regenerateDocument(orgId: string, id: string): Promise<RequestedDocument> {
  const row = await prisma.document.findFirst({ where: { id, organizationId: orgId } });
  if (!row) throw new DocumentsError(404, "NOT_FOUND", "Document not found in this organization.");
  await prisma.document.update({ where: { id: row.id }, data: { status: "PENDING" } });
  try {
    await enqueueGenerateDocumentPdf({
      jobName: DOCUMENT_JOB_NAMES[row.entityType as DocumentEntityType],
      documentId: row.id,
      organizationId: orgId,
    });
  } catch (error) {
    await prisma.document.update({ where: { id: row.id }, data: { status: "FAILED" } });
    throw error;
  }
  return { id: row.id, entityType: row.entityType, entityId: row.entityId, status: "PENDING" };
}

/**
 * Worker entry: render + upload + mark GENERATED. Data errors (missing
 * entity, unsupported type) are permanent — the job must not retry them;
 * storage/transient errors rethrow so BullMQ's backoff can retry.
 */
export async function generateDocument(documentId: string): Promise<void> {
  const row = await prisma.document.findFirst({ where: { id: documentId } });
  if (!row) throw new DocumentsError(404, "NOT_FOUND", "Document not found.");
  try {
    const params = (row.paramsJson as Record<string, string> | null) ?? {};
    const { pdf } = await buildDocumentPdf({
      orgId: row.organizationId,
      entityType: row.entityType as DocumentEntityType,
      entityId: row.entityId,
      params,
    });
    const storageKey = `${row.organizationId}/${row.entityType}/${row.id}.pdf`;
    let checksum: string;
    try {
      ({ checksum } = await putDocument(storageKey, pdf, PDF_CONTENT_TYPE));
    } catch (error) {
      if (error instanceof StorageError) {
        throw new DocumentsError(error.status, error.code, error.message);
      }
      throw error;
    }
    await prisma.document.update({
      where: { id: row.id },
      data: { status: "GENERATED", storageKey, contentType: PDF_CONTENT_TYPE, checksum },
    });
    await writeAudit({
      organizationId: row.organizationId,
      actorUserId: null, // worker-side completion — no user session (§17 system events)
      action: AUDIT_ACTIONS.DOCUMENTS.GENERATED,
      entityType: "Document",
      entityId: row.id,
      afterJson: {
        entityType: row.entityType,
        entityId: row.entityId,
        storageKey,
        checksum,
        bytes: pdf.length,
      },
    });
  } catch (error) {
    const permanent =
      error instanceof DocumentsError && (error.status === 400 || error.status === 404);
    const safeMessage =
      error instanceof DocumentsError
        ? error.message
        : "Generation failed — see server logs for details.";
    await prisma.document.update({
      where: { id: row.id },
      data: { status: "FAILED" },
    });
    await writeAudit({
      organizationId: row.organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.DOCUMENTS.GENERATION_FAILED,
      entityType: "Document",
      entityId: row.id,
      metadataJson: { permanent, message: safeMessage },
    });
    if (permanent) {
      // Surface as unrecoverable upstream (the worker wraps job errors).
      throw error;
    }
    throw error;
  }
}

export interface DownloadableDocument {
  row: Document;
  object: StoredObject;
}

/** Org-scoped download; only GENERATED documents have an object to stream. */
export async function getDocumentForDownload(orgId: string, id: string): Promise<DownloadableDocument> {
  const row = await prisma.document.findFirst({ where: { id, organizationId: orgId } });
  if (!row) throw new DocumentsError(404, "NOT_FOUND", "Document not found in this organization.");
  if (row.status !== "GENERATED") {
    throw new DocumentsError(409, "DOCUMENT_NOT_READY", `Document status is ${row.status}.`);
  }
  let object: StoredObject;
  try {
    object = await getDocument(row.storageKey);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new DocumentsError(error.status, error.code, error.message);
    }
    throw error;
  }
  return { row, object };
}

/** Recent documents for the org, newest first (the /documents page). */
export async function listDocuments(orgId: string, entityType?: string): Promise<Document[]> {
  return prisma.document.findMany({
    where: { organizationId: orgId, ...(entityType ? { entityType } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
