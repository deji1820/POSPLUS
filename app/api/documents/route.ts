/**
 * POST /api/documents — request a generated document (SPEC.md §7 documents
 * outline, §19 envelope, issue #32). Body: { entityType, entityId?, params? }
 * with entityType in PURCHASE_ORDER | PAYSLIP | PNL_REPORT. Creates a PENDING
 * Document row, enqueues the render on the documents queue, and audits the
 * request. The module gate is per document type (§5 role matrix), resolved
 * dynamically after the body is parsed.
 *
 * GET /api/documents — this org's documents, newest first (powers /documents).
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiRoute } from "@/lib/api/handler";
import { apiError, ok } from "@/lib/api/envelope";
import { requireModule } from "@/lib/auth/guard";
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import {
  DOCUMENT_TYPE_MODULES,
  parseDocumentRequest,
} from "@/lib/documents/entities";
import { DocumentsError } from "@/lib/documents/errors";
import { listDocuments, requestDocument } from "@/lib/documents";
import { QueueUnavailableError } from "@/lib/queue/enqueue";

export const runtime = "nodejs";

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof DocumentsError || error instanceof AuthContextError) {
    return NextResponse.json(apiError(error.code, error.message), { status: error.status });
  }
  if (error instanceof QueueUnavailableError) {
    return NextResponse.json(apiError("QUEUE_UNAVAILABLE", error.message), { status: 503 });
  }
  return null; // unexpected — let apiRoute's net handle it
}

export const POST = apiRoute(async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => null);
    const { entityType } = parseDocumentRequest(body); // validates before any write
    const ctx = await requireModule(DOCUMENT_TYPE_MODULES[entityType]);
    const document = await requestDocument(ctx.orgId, ctx.userId, body);
    return NextResponse.json(ok({ document }), { status: 201 });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
});

export const GET = apiRoute(async () => {
  try {
    const ctx = await getSessionContext();
    const documents = await listDocuments(ctx.orgId);
    return NextResponse.json(ok({ documents }));
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
});
