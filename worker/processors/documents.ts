/**
 * Documents queue processor (SPEC.md §10/§20, issue #32): renders one
 * requested document (PO / payslip / P&L PDF), uploads it to object
 * storage, and flips the Document row to GENERATED with its checksum.
 *
 * Data problems (missing entity, bad type) are permanent — retrying cannot
 * fix them — so they surface as UnrecoverableError and dead-letter.
 * Storage/infra failures stay retryable.
 */
import { UnrecoverableError, type Job } from "bullmq";

import { generateDocument } from "@/lib/documents";
import { DocumentsError } from "@/lib/documents/errors";

export interface GenerateDocumentJobData {
  documentId: string;
  organizationId: string;
}

export async function processGenerateDocumentJob(job: Job): Promise<unknown> {
  const data = job.data as GenerateDocumentJobData;
  if (!data?.documentId || typeof data.documentId !== "string") {
    throw new UnrecoverableError("Document job is missing its documentId.");
  }
  try {
    await generateDocument(data.documentId);
    return { documentId: data.documentId };
  } catch (error) {
    if (error instanceof DocumentsError && (error.status === 400 || error.status === 404)) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}
