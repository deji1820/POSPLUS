/**
 * Documents queue processor (SPEC.md §10/§20, issue #32): the generate-*-pdf
 * jobs. Data problems (missing documentId, 4xx from the pipeline) must
 * dead-letter as UnrecoverableError; storage/infra failures stay retryable
 * and rethrow untouched. generateDocument itself is mocked — its behavior is
 * pinned in tests/documents-service.test.ts.
 */
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateDocument: vi.fn(),
}));

vi.mock("@/lib/documents", () => ({
  generateDocument: mocks.generateDocument,
  requestDocument: vi.fn(),
  regenerateDocument: vi.fn(),
  getDocumentForDownload: vi.fn(),
  listDocuments: vi.fn(),
}));

import { DocumentsError } from "@/lib/documents/errors";
import { processGenerateDocumentJob } from "@/worker/processors/documents";

function job(data: unknown): { data: unknown; name: string } {
  return { data, name: "generate-po-pdf" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateDocument.mockResolvedValue(undefined);
});

describe("processGenerateDocumentJob", () => {
  it("runs the pipeline for a well-formed job", async () => {
    const out = await processGenerateDocumentJob(job({ documentId: "doc-1", organizationId: "org-1" }) as never);
    expect(mocks.generateDocument).toHaveBeenCalledWith("doc-1");
    expect(out).toEqual({ documentId: "doc-1" });
  });

  it("dead-letters a job with no documentId (UnrecoverableError)", async () => {
    await expect(processGenerateDocumentJob(job({}) as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(mocks.generateDocument).not.toHaveBeenCalled();
  });

  it.each([400, 404])("dead-letters DocumentsError %i (permanent)", async (status) => {
    mocks.generateDocument.mockRejectedValue(new DocumentsError(status, "NOT_FOUND", "gone"));
    await expect(
      processGenerateDocumentJob(job({ documentId: "doc-1" }) as never),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("rethrows retryable failures (e.g. storage 502) unchanged", async () => {
    const boom = new DocumentsError(502, "STORAGE_UNAVAILABLE", "up");
    mocks.generateDocument.mockRejectedValue(boom);
    await expect(
      processGenerateDocumentJob(job({ documentId: "doc-1" }) as never),
    ).rejects.toBe(boom);
  });
});
