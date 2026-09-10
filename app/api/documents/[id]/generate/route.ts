/**
 * POST /api/documents/:id/generate — re-enqueue an existing document
 * (issue #32). Used from /documents to retry a FAILED document or refresh a
 * stale one. The module gate is the document type's module (§5), resolved
 * after the org-scoped row is loaded — without the row there is nothing to
 * gate.
 */
import { NextResponse } from "next/server";

import { apiRoute } from "@/lib/api/handler";
import { apiError, ok } from "@/lib/api/envelope";
import { requireModule } from "@/lib/auth/guard";
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { DOCUMENT_TYPE_MODULES, type DocumentEntityType } from "@/lib/documents/entities";
import { DocumentsError } from "@/lib/documents/errors";
import { regenerateDocument } from "@/lib/documents";
import { prisma } from "@/lib/db";
import { QueueUnavailableError } from "@/lib/queue/enqueue";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof DocumentsError || error instanceof AuthContextError) {
    return NextResponse.json(apiError(error.code, error.message), { status: error.status });
  }
  if (error instanceof QueueUnavailableError) {
    return NextResponse.json(apiError("QUEUE_UNAVAILABLE", error.message), { status: 503 });
  }
  return null;
}

export const POST = apiRoute(async (_req: Request, context: RouteContext) => {
  try {
    const { id } = await context.params;
    const session = await getSessionContext(); // tenant gate before the row peek
    const row = await prisma.document.findFirst({
      where: { id, organizationId: session.orgId },
      select: { entityType: true },
    });
    if (!row) {
      throw new DocumentsError(404, "NOT_FOUND", "Document not found in this organization.");
    }
    const ctx = await requireModule(DOCUMENT_TYPE_MODULES[row.entityType as DocumentEntityType]);
    const document = await regenerateDocument(ctx.orgId, id);
    return NextResponse.json(ok({ document }));
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
});
