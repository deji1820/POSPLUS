import { describe, expect, it } from "vitest";

import { redisConnectionOpts } from "@/lib/queue/config";
import {
  DEFAULT_JOB_OPTIONS,
  isQueueName,
  JOB_QUEUES,
  QUEUE_NAMES,
} from "@/lib/queue/queues";
import { resolveProcessor } from "@/worker/registry";

describe("queue registry (SPEC.md §10)", () => {
  it("declares all eight SPEC queues", () => {
    expect(QUEUE_NAMES).toEqual([
      "loyverse-webhooks",
      "loyverse-sync",
      "finance-posting",
      "inventory",
      "reorder",
      "payroll",
      "documents",
      "analytics",
    ]);
  });

  it("maps every job name to a declared queue", () => {
    for (const [job, queue] of Object.entries(JOB_QUEUES)) {
      expect(QUEUE_NAMES).toContain(queue);
      expect(isQueueName(queue)).toBe(true);
      expect(job.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate job names", () => {
    const names = Object.keys(JOB_QUEUES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects unknown queue names", () => {
    expect(isQueueName("nope")).toBe(false);
    expect(isQueueName("loyverse-sync")).toBe(true);
  });

  it("ships a retry policy with exponential backoff", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: "exponential" });
  });
});

describe("redisConnectionOpts", () => {
  it("parses REDIS_URL with credentials and db index", () => {
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://user:pass@example.com:6380/2";
    try {
      expect(redisConnectionOpts()).toEqual({
        host: "example.com",
        port: 6380,
        username: "user",
        password: "pass",
        db: 2,
        maxRetriesPerRequest: null,
      });
    } finally {
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
  });

  it("defaults to local docker-compose Redis", () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const opts = redisConnectionOpts();
      expect(opts.host).toBe("localhost");
      expect(opts.port).toBe(6379);
    } finally {
      if (original !== undefined) process.env.REDIS_URL = original;
    }
  });
});

describe("processor registry", () => {
  it("resolves real processors for the loyverse-sync job names", () => {
    expect(resolveProcessor("initial-loyverse-sync")).toBeDefined();
    expect(resolveProcessor("incremental-loyverse-sync")).toBeDefined();
  });

  it("resolves the real processor for process-loyverse-webhook (#9)", async () => {
    const { processLoyverseWebhookJob } = await import("@/worker/processors/loyverse-webhook");
    expect(resolveProcessor("process-loyverse-webhook")).toBe(processLoyverseWebhookJob);
  });

  it("routes unimplemented job names to a permanent dead-letter stub", async () => {
    const stub = resolveProcessor("calculate-payroll");
    const { UnrecoverableError } = await import("bullmq");
    await expect(stub({ name: "calculate-payroll" } as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
