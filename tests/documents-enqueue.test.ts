/** Regression: a retained failed BullMQ job must not strand a retry in PENDING. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("@/lib/queue/queues", () => ({
  getQueue: () => ({ add: mocks.add, getJob: mocks.getJob }),
  JOB_QUEUES: { "generate-po-pdf": "documents" },
}));

import { enqueueGenerateDocumentPdf } from "@/lib/queue/enqueue";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue(undefined);
  mocks.getJob.mockResolvedValue(null);
});

describe("enqueueGenerateDocumentPdf", () => {
  it("adds the first document job to the documents queue", async () => {
    await enqueueGenerateDocumentPdf({
      jobName: "generate-po-pdf",
      documentId: "doc-1",
      organizationId: "org-1",
    });

    expect(mocks.add).toHaveBeenCalledWith(
      "generate-po-pdf",
      { documentId: "doc-1", organizationId: "org-1" },
      { jobId: "document-pdf-doc-1" },
    );
  });

  it("replaces a retained failed job so a document retry is runnable", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue("failed"), remove });

    await enqueueGenerateDocumentPdf({
      jobName: "generate-po-pdf",
      documentId: "doc-1",
      organizationId: "org-1",
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it("does not replace an active job", async () => {
    const remove = vi.fn();
    mocks.getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue("active"), remove });

    await enqueueGenerateDocumentPdf({
      jobName: "generate-po-pdf",
      documentId: "doc-1",
      organizationId: "org-1",
    });

    expect(remove).not.toHaveBeenCalled();
    expect(mocks.add).toHaveBeenCalledOnce();
  });
});
