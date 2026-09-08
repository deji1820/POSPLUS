/**
 * In-memory fixed-window rate limiter for auth endpoints (SPEC.md §18).
 * Sufficient for a single-process dev/early deployment; replace with a
 * Redis-backed limiter in the Sprint 5 hardening pass (#34).
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  limit = 10,
  windowMs = 5 * 60 * 1000,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/** Test hook: clear all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
