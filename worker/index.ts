/**
 * BullMQ worker entrypoint (SPEC.md §3, §10).
 * Queue consumers are registered here as they land
 * (initial sync, webhooks, finance posting, payroll, ...).
 */

function main() {
  // TODO(#6): connect to Redis and register queue consumers.
  console.log("posplus worker: no queues registered yet (see issue #6)");
}

main();
