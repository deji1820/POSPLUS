import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, resetRateLimits } from "@/lib/auth/rate-limit";

// Force the in-memory fallback so the test needs no Redis (§18 documents
// RATE_LIMIT_BACKEND=memory for tests/local scripts).
beforeEach(() => {
  process.env.RATE_LIMIT_BACKEND = "memory";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
});

afterEach(() => {
  resetRateLimits();
  vi.useRealTimers();
  delete process.env.RATE_LIMIT_BACKEND;
});

describe("rate limiter (SPEC.md §18/§22)", () => {
  it("allows requests within the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await checkRateLimit("user:1", 5, 60_000)).toBe(true);
    }
  });

  it("blocks requests past the limit", async () => {
    for (let i = 0; i < 5; i += 1) await checkRateLimit("user:2", 5, 60_000);
    expect(await checkRateLimit("user:2", 5, 60_000)).toBe(false);
  });

  it("tracks buckets independently per key", async () => {
    for (let i = 0; i < 5; i += 1) await checkRateLimit("user:3", 5, 60_000);
    expect(await checkRateLimit("user:4", 5, 60_000)).toBe(true);
  });

  it("resets after the window elapses", async () => {
    expect(await checkRateLimit("user:5", 1, 1_000)).toBe(true);
    expect(await checkRateLimit("user:5", 1, 1_000)).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(await checkRateLimit("user:5", 1, 1_000)).toBe(true);
  });

  it("uses the documented defaults (10 per 5 minutes)", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(await checkRateLimit("login:defaults")).toBe(true);
    }
    expect(await checkRateLimit("login:defaults")).toBe(false);
    // And a different key is unaffected.
    expect(await checkRateLimit("login:other")).toBe(true);
  });
});
