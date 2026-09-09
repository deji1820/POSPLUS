-- AlterTable
-- Resumability checkpoints for the Loyverse sync engine (#7): completed
-- resources + per-resource pagination cursors, so a retried SyncRun resumes
-- where the failed attempt stopped (SPEC.md §9).
ALTER TABLE "SyncRun" ADD COLUMN "progress" JSONB;
