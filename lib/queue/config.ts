/**
 * Redis connection configuration for BullMQ (SPEC.md §10).
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its blocking connections —
 * commands must block indefinitely rather than error after N retries.
 *
 * REDIS_URL falls back to the local docker-compose default (SPEC.md §23) so
 * `next build` and tests never need Redis; real connections are only opened
 * when a queue is actually used at runtime.
 */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** Concrete option shape we hand to BullMQ (its ConnectionOptions is a union). */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  maxRetriesPerRequest: null;
}

export function redisConnectionOpts(): RedisConnectionOptions {
  const raw = process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}
