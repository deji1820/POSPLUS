import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, resetRateLimits } from "@/lib/auth/rate-limit";

describe("in-memory rate limiter (SPEC.md §18)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
  });

  afterEach(() => {
    resetRateLimits();
    vi.useRealTimers();
  });

  it("allows requests within the limit", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit("user:1", 5, 60_000)).toBe(true);
    }
  });

  it("blocks requests past the limit", () => {
    for (let i = 0; i < 5; i += 1) checkRateLimit("user:2", 5, 60_000);
    expect(checkRateLimit("user:2", 5, 60_000)).toBe(false);
  });

  it("tracks buckets independently per key", () => {
    for (let i = 0; i < 5; i += 1) checkRateLimit("user:3", 5, 60_000);
    expect(checkRateLimit("user:4", 5, 60_000)).toBe(true);
  });

  it("resets after the window elapses", () => {
    expect(checkRateLimit("user:5", 1, 1_000)).toBe(true);
    expect(checkRateLimit("user:5", 1, 1_000)).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(checkRateLimit("user:5", 1, 1_000)).toBe(true);
  });
});
