/**
 * Documents service (SPEC.md §20, issue #32): request → PENDING row + queue
 * job → worker renders → S3 upload → GENERATED with checksum → audit. prisma,
 * storage, the queue, and the PDF builders are mocked; parseDocumentRequest
 * and the DocumentsError/StorageError classes stay real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documentCreate: vi.fn(),
  documentUpdate: vi.fn(),
  documentFindFirst: vi.fn(),
  documentFindMany: vi.fn(),
  buildDocumentPdf: vi.fn(),
  putDocument: vi.fn(),
  getDocument: vi.fn(),
  enqueueGenerateDocumentPdf: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    document: {
      create: mocks.documentCreate,
      update: mocks.documentUpdate,
      findFirst: mocks.documentFindFirst,
      findMany: mocks.documentFindMany,
    },
  },
}));

vi.mock("@/lib/documents/entities", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/documents/entities")>();
  return { ...actual, buildDocumentPdf: mocks.buildDocumentPdf };
});

vi.mock("@/lib/storage", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/storage")>();
  return {
    ...actual,
    putDocument: mocks.putDocument,
    getDocument: mocks.getDocument,
  };
});

vi.mock("@/lib/queue/enqueue", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/queue/enqueue")>();
  return { ...actual, enqueueGenerateDocumentPdf: mocks.enqueueGenerateDocumentPdf };
});

vi.mock("@/lib/audit/writer", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/audit/writer")>();
  return { ...actual, writeAudit: mocks.writeAudit };
});

import {
  generateDocument,
  getDocumentForDownload,
  listDocuments,
  regenerateDocument,
  requestDocument,
} from "@/lib/documents";
import { DocumentsError } from "@/lib/documents/errors";
import { QueueUnavailableError } from "@/lib/queue/enqueue";
import { StorageError } from "@/lib/storage";

const PENDING_ROW = {
  id: "doc-1",
  organizationId: "org-1",
  entityType: "PURCHASE_ORDER",
  entityId: "po-1",
  paramsJson: null,
  storageKey: "",
  contentType: "application/pdf",
  checksum: "",
  status: "PENDING",
  createdAt: new Date("2026-09-10T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.documentCreate.mockResolvedValue({ ...PENDING_ROW });
  mocks.enqueueGenerateDocumentPdf.mockResolvedValue(undefined);
  mocks.buildDocumentPdf.mockResolvedValue({ pdf: Buffer.from("%PDF-fake"), label: "PO PO-1" });
  mocks.putDocument.mockResolvedValue({ checksum: "abc123" });
});

describe("requestDocument", () => {
  it("creates a PENDING row, enqueues the render job, and audits the request", async () => {
    const out = await requestDocument("org-1", "user-1", {
      entityType: "PURCHASE_ORDER",
      entityId: "po-1",
    });
    expect(out).toEqual({ id: "doc-1", entityType: "PURCHASE_ORDER", entityId: "po-1", status: "PENDING" });
    expect(mocks.documentCreate.mock.calls[0][0].data.organizationId).toBe("org-1");
    expect(mocks.enqueueGenerateDocumentPdf).toHaveBeenCalledWith({
      jobName: "generate-po-pdf",
      documentId: "doc-1",
      organizationId: "org-1",
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        actorUserId: "user-1",
        action: "document.requested",
        entityType: "Document",
        entityId: "doc-1",
      }),
    );
  });

  it("stores paramsJson for parameterized documents (P&L) with a null entityId", async () => {
    await requestDocument("org-1", "user-1", {
      entityType: "PNL_REPORT",
      params: { from: "2026-08-01", to: "2026-08-31" },
    });
    const data = mocks.documentCreate.mock.calls[0][0].data;
    expect(data.entityId).toBeNull();
    expect(data.paramsJson).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(mocks.enqueueGenerateDocumentPdf).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "generate-pnl-pdf" }),
    );
  });

  it.each([
    [{ entityType: "NOPE" }, "Unsupported document type"],
    [{ entityType: "PURCHASE_ORDER" }, "entityId is required"],
    [{ entityType: "PNL_REPORT", entityId: "x" }, "take params, not an entityId"],
  ])("rejects invalid input %j before any write", async (raw, message) => {
    await expect(requestDocument("org-1", "user-1", raw)).rejects.toThrow(message);
    expect(mocks.documentCreate).not.toHaveBeenCalled();
  });

  it("marks the row FAILED and rethrows when the queue is unavailable", async () => {
    mocks.enqueueGenerateDocumentPdf.mockRejectedValue(new QueueUnavailableError());
    await expect(
      requestDocument("org-1", "user-1", { entityType: "PURCHASE_ORDER", entityId: "po-1" }),
    ).rejects.toThrow("unavailable");
    expect(mocks.documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc-1" }, data: { status: "FAILED" } }),
    );
  });
});

describe("generateDocument (worker entry)", () => {
  it("renders, uploads under org/type/id key, marks GENERATED with checksum, audits with null actor", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW });
    await generateDocument("doc-1");
    expect(mocks.buildDocumentPdf).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", entityType: "PURCHASE_ORDER", entityId: "po-1" }),
    );
    expect(mocks.putDocument).toHaveBeenCalledWith(
      "org-1/PURCHASE_ORDER/doc-1.pdf",
      Buffer.from("%PDF-fake"),
      "application/pdf",
    );
    expect(mocks.documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-1" },
        data: expect.objectContaining({ status: "GENERATED", checksum: "abc123" }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.generated",
        actorUserId: null,
        entityId: "doc-1",
      }),
    );
  });

  it("throws DocumentsError 404 when the row does not exist", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);
    await expect(generateDocument("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("marks FAILED and audits generation_failed on a data error (permanent, no retry)", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW });
    mocks.buildDocumentPdf.mockRejectedValue(new DocumentsError(404, "NOT_FOUND", "PO gone"));
    await expect(generateDocument("doc-1")).rejects.toMatchObject({ status: 404 });
    expect(mocks.documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.generation_failed",
        metadataJson: expect.objectContaining({ permanent: true }),
      }),
    );
  });

  it("marks FAILED and rethrows storage errors so BullMQ can retry", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW });
    mocks.putDocument.mockRejectedValue(new StorageError(502, "STORAGE_UNAVAILABLE", "up"));
    await expect(generateDocument("doc-1")).rejects.toMatchObject({ status: 502 });
    expect(mocks.documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "FAILED" } }),
    );
    const audit = mocks.writeAudit.mock.calls.at(-1)![0] as { metadataJson: { permanent: boolean } };
    expect(audit.metadataJson.permanent).toBe(false);
  });
});

describe("regenerateDocument", () => {
  it("resets to PENDING and re-enqueues", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW, status: "FAILED" });
    const out = await regenerateDocument("org-1", "doc-1");
    expect(out.status).toBe("PENDING");
    expect(mocks.enqueueGenerateDocumentPdf).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "generate-po-pdf", documentId: "doc-1" }),
    );
  });

  it("404 when the document belongs to another org (org-scoped findFirst)", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);
    await expect(regenerateDocument("org-1", "doc-2")).rejects.toMatchObject({ status: 404 });
    expect(mocks.enqueueGenerateDocumentPdf).not.toHaveBeenCalled();
  });
});

describe("getDocumentForDownload", () => {
  it("404 for another org's document", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);
    await expect(getDocumentForDownload("org-1", "doc-2")).rejects.toMatchObject({ status: 404 });
  });

  it("409 DOCUMENT_NOT_READY until GENERATED", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW });
    await expect(getDocumentForDownload("org-1", "doc-1")).rejects.toMatchObject({
      status: 409,
      code: "DOCUMENT_NOT_READY",
    });
  });

  it("streams the stored object for a GENERATED document", async () => {
    const row = { ...PENDING_ROW, status: "GENERATED", storageKey: "org-1/PURCHASE_ORDER/doc-1.pdf" };
    mocks.documentFindFirst.mockResolvedValue(row);
    mocks.getDocument.mockResolvedValue({
      body: (async function* () {
        yield Buffer.from("%PDF-1.4");
      })(),
      contentType: "application/pdf",
      contentLength: 8,
    });
    const { row: outRow, object } = await getDocumentForDownload("org-1", "doc-1");
    expect(outRow.id).toBe("doc-1");
    expect(object.contentType).toBe("application/pdf");
    expect(mocks.getDocument).toHaveBeenCalledWith("org-1/PURCHASE_ORDER/doc-1.pdf");
  });
});

describe("listDocuments", () => {
  it("scopes to the org, newest first, capped at 100", async () => {
    mocks.documentFindMany.mockResolvedValue([]);
    await listDocuments("org-1");
    expect(mocks.documentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    );
  });
});
