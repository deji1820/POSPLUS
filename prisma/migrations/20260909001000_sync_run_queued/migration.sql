-- AlterEnum: add QUEUED so accepted sync jobs can be recorded honestly
-- before the BullMQ worker (#6) and sync implementations (#7) land.
ALTER TYPE "SyncRunStatus" ADD VALUE 'QUEUED';
