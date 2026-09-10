/**
 * GET /api/documents/:id/download — authenticated download of a GENERATED
 * document (SPEC.md §20, issue #32). The S3-compatible object streams
 * through the app: the browser never sees storage credentials or signed
 * URLs, and cross-org access is a plain 404. The module gate is the
 * document type's module (§5 role matrix), resolved from the stored row.
 */
import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api/handler";
import { apiError } from "@/lib/api/envelope";
import { requireModule } from "@/lib/auth/guard";
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { DOCUMENT_TYPE_MODULES, type DocumentEntityType } from "@/lib/documents/entities";
import { DocumentsError } from "@/lib/documents/errors";
import { getDocumentForDownload } from "@/lib/documents";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof DocumentsError || error instanceof AuthContextError) {
    return NextResponse.json(apiError(error.code, error.message), { status: error.status });
  }
  return null;
}

export const GET = apiRoute(async (_req: Request, context: RouteContext) => {
  try {
    const { id } = await context.params;
    const session = await getSessionContext();
    // Peek for the module gate; 404 covers both missing and wrong-org (§24).
    const row = await prisma.document.findFirst({
      where: { id, organizationId: session.orgId },
      select: { entityType: true },
    });
    if (!row) {
      throw new DocumentsError(404, "NOT_FOUND", "Document not found in this organization.");
    }
    await requireModule(DOCUMENT_TYPE_MODULES[row.entityType as DocumentEntityType]);
    const { row: document, object } = await getDocumentForDownload(session.orgId, id);

    const chunks: Buffer[] = [];
    for await (const chunk of object.body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": document.contentType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": `attachment; filename="document-${document.id}.pdf"`,
        "X-Content-SHA256": document.checksum,
      },
    });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
});
