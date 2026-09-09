/**
 * Job-name → processor registry (SPEC.md §10).
 *
 * Only `initial-loyverse-sync` / `incremental-loyverse-sync` have real
 * processors in #6; every other SPEC §10 job type routes to a permanent
 * not-implemented stub that dead-letters immediately with an operator-safe
 * reason recorded in the failed set (§19). Domain issues register their
 * processors here as they land.
 */
import { UnrecoverableError, type Job } from "bullmq";

import { processLoyverseSyncJob } from "@/worker/processors/loyverse-sync";

export type Processor = (job: Job) => Promise<unknown>;

const registry = new Map<string, Processor>([
  ["initial-loyverse-sync", processLoyverseSyncJob as Processor],
  ["incremental-loyverse-sync", processLoyverseSyncJob as Processor],
]);

export function registerProcessor(jobName: string, processor: Processor): void {
  registry.set(jobName, processor);
}

export function resolveProcessor(jobName: string): Processor {
  const registered = registry.get(jobName);
  if (registered) return registered;
  return () =>
    Promise.reject(
      new UnrecoverableError(`Job "${jobName}" is not implemented yet.`),
    );
}
