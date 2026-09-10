-- Document generation inputs (#32).
-- - paramsJson: inputs that are not an entity id (P&L period/store/compare
--   filters) so the worker can re-render long after the request.
-- - entityId nullable: parameterized documents (P&L reports) have no single
--   entity row; row-based documents keep a required reference in practice.
ALTER TABLE "Document" ADD COLUMN "paramsJson" JSONB,
ALTER COLUMN "entityId" DROP NOT NULL;
