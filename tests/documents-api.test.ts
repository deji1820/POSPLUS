/**
 * Documents API routes (SPEC.md §19/§20, issue #32):
 *   POST /api/documents            — request a document (module-gated per type)
 *   GET  /api/documents            — org's documents, newest first
 *   POST /api/documents/:id/generate — re-enqueue (module-gated)
 *   GET  /api/documents/:id/download — authenticated stream from object storage
 *
 * The real service runs against mocked prisma/storage/queue/builders; the
 * session context and requireModule gate are mocked with a fixed owner ctx
 * (auth itself is covered by tests/guard.test.ts).
 */
import { NextRequest } from "next/server";
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
  requireModule: vi.fn(),
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

vi.mock("@/lib/auth/session-context", () => ({
  AuthContextError: class AuthContextError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "AuthContextError";
    }
  },
  getSessionContext: vi.fn(async () => ({
    userId: "user-1",
    email: "owner@x.io",
    orgId: "org-1",
    role: "OWNER",
    storeIds: null,
    warehouseIds: null,
  })),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireModule: mocks.requireModule,
}));

vi.mock("@/lib/documents/entities", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/documents/entities")>();
  return { ...actual, buildDocumentPdf: mocks.buildDocumentPdf };
});

vi.mock("@/lib/storage", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/storage")>();
  return { ...actual, putDocument: mocks.putDocument, getDocument: mocks.getDocument };
});

vi.mock("@/lib/queue/enqueue", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/queue/enqueue")>();
  return { ...actual, enqueueGenerateDocumentPdf: mocks.enqueueGenerateDocumentPdf };
});

vi.mock("@/lib/audit/writer", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/audit/writer")>();
  return { ...actual, writeAudit: mocks.writeAudit };
});

import { GET as LIST, POST as REQUEST } from "@/app/api/documents/route";
import { POST as GENERATE } from "@/app/api/documents/[id]/generate/route";
import { GET as DOWNLOAD } from "@/app/api/documents/[id]/download/route";

const OWNER_CTX = {
  userId: "user-1",
  email: "owner@x.io",
  orgId: "org-1",
  role: "OWNER",
  storeIds: null,
  warehouseIds: null,
};

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

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return res.json() as Promise<{
    ok: boolean;
    data?: Record<string, never>;
    error?: { code: string; message: string };
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireModule.mockResolvedValue(OWNER_CTX);
  mocks.documentCreate.mockResolvedValue({ ...PENDING_ROW });
  mocks.enqueueGenerateDocumentPdf.mockResolvedValue(undefined);
  mocks.documentFindMany.mockResolvedValue([]);
});

describe("POST /api/documents", () => {
  it("gates on the document type's module, then requests + enqueues", async () => {
    const res = await REQUEST(post("http://x/api/documents", { entityType: "PURCHASE_ORDER", entityId: "po-1" }));
    expect(res.status).toBe(201);
    expect((await json(res)).ok).toBe(true);
    expect(mocks.requireModule).toHaveBeenCalledWith("PURCHASING");
    expect(mocks.documentCreate.mock.calls[0][0].data.organizationId).toBe("org-1");
    expect(mocks.enqueueGenerateDocumentPdf).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: "generate-po-pdf", organizationId: "org-1" }),
    );
  });

  it("maps a module denial to the §19 envelope (403) instead of a 500", async () => {
    const { AuthContextError } = await import("@/lib/auth/session-context");
    mocks.requireModule.mockRejectedValue(new AuthContextError(403, "FORBIDDEN", "No PAYROLL access."));
    const res = await REQUEST(post("http://x/api/documents", { entityType: "PAYSLIP", entityId: "pl-1" }));
    expect(res.status).toBe(403);
    expect((await json(res)).error!.code).toBe("FORBIDDEN");
    expect(mocks.documentCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies with VALIDATION_ERROR before gating", async () => {
    const res = await REQUEST(post("http://x/api/documents", { entityType: "PURCHASE_ORDER" }));
    expect(res.status).toBe(400);
    expect((await json(res)).error!.code).toBe("VALIDATION_ERROR");
    expect(mocks.requireModule).not.toHaveBeenCalled();
    expect(mocks.documentCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/documents", () => {
  it("lists this org's documents", async () => {
    const res = await LIST(new Request("http://x/api/documents") as never);
    expect(res.status).toBe(200);
    expect(mocks.documentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1" } }),
    );
  });
});

describe("POST /api/documents/:id/generate", () => {
  it("re-enqueues an existing FAILED document", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW, status: "FAILED" });
    const res = await GENERATE(new Request("http://x/api/documents/doc-1/generate", { method: "POST" }) as never, {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(200);
    expect(mocks.requireModule).toHaveBeenCalledWith("PURCHASING");
    expect(mocks.enqueueGenerateDocumentPdf).toHaveBeenCalled();
  });

  it("404 when the document is not in this org", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);
    const res = await GENERATE(new Request("http://x/api/documents/doc-9/generate", { method: "POST" }) as never, {
      params: Promise.resolve({ id: "doc-9" }),
    });
    expect(res.status).toBe(404);
    expect(mocks.enqueueGenerateDocumentPdf).not.toHaveBeenCalled();
  });
});

describe("GET /api/documents/:id/download", () => {
  it("streams a GENERATED document as an attachment with its checksum", async () => {
    mocks.documentFindFirst.mockResolvedValue({
      ...PENDING_ROW,
      status: "GENERATED",
      storageKey: "org-1/PURCHASE_ORDER/doc-1.pdf",
      checksum: "abc123",
    });
    mocks.getDocument.mockResolvedValue({
      body: (async function* () {
        yield Buffer.from("%PDF-1.4 fake");
      })(),
      contentType: "application/pdf",
      contentLength: 13,
    });
    const res = await DOWNLOAD(new Request("http://x/api/documents/doc-1/download") as never, {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="document-doc-1.pdf"');
    expect(res.headers.get("X-Content-SHA256")).toBe("abc123");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.4 fake");
  });

  it("404 for another org's document — no cross-tenant download", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);
    const res = await DOWNLOAD(new Request("http://x/api/documents/doc-2/download") as never, {
      params: Promise.resolve({ id: "doc-2" }),
    });
    expect(res.status).toBe(404);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("409 while the document is still PENDING", async () => {
    mocks.documentFindFirst.mockResolvedValue({ ...PENDING_ROW });
    const res = await DOWNLOAD(new Request("http://x/api/documents/doc-1/download") as never, {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error!.code).toBe("DOCUMENT_NOT_READY");
  });
});
