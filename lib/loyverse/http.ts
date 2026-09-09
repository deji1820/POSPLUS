/**
 * Authenticated Loyverse read client for the sync engine (SPEC.md §9).
 *
 * - Official API only; never logs the API key or full response bodies (§24 —
 *   business/customer data stays out of logs; only event/resource ids and
 *   cursors are logged).
 * - Retries transient failures with exponential backoff: network errors,
 *   429 (rate limit, honoring Retry-After up to a cap), and 5xx. Retry-After
 *   takes precedence when Loyverse sends it.
 * - 401/403 is permanent (the stored key was revoked) — the engine tells the
 *   operator to reconnect rather than burning retries.
 * - Exhausted retries surface as TransientJobError so the BullMQ job retries
 *   with its own backoff and the run resumes from its checkpoint.
 */
import { loyverseApiBase } from "@/lib/loyverse/client";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface LoyverseListResponse {
  cursor?: unknown;
  [key: string]: unknown;
}

export interface LoyversePage {
  items: Record<string, unknown>[];
  cursor: string | null;
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const capped = Number.isFinite(header) && header > 0 ? header * 1000 : BASE_BACKOFF_MS;
  return Math.min(Math.max(capped, BASE_BACKOFF_MS * 2 ** attempt), MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

export class LoyverseHttp {
  constructor(
    private readonly apiKey: string,
    private readonly sleep: Sleep = defaultSleep,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * GET a list endpoint with Loyverse cursor pagination: repeats until the
   * response carries no cursor, invoking onPage after each page so the sync
   * engine can persist its checkpoint mid-resource. A cursor passed in params
   * is the resume checkpoint — it seeds the FIRST request (a retried job
   * continues mid-resource instead of re-fetching completed pages).
   */
  async *paginate(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<LoyversePage, void, void> {
    let cursor: string | null =
      typeof params.cursor === "string" && params.cursor ? params.cursor : null;
    do {
      const page = await this.getPage(path, { ...params, cursor: cursor ?? undefined });
      yield page;
      cursor = page.cursor;
    } while (cursor !== null);
  }

  private async getPage(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<LoyversePage> {
    const url = new URL(`${loyverseApiBase()}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt >= MAX_ATTEMPTS) {
          throw new TransientJobError("Loyverse did not respond after repeated attempts.");
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new UnrecoverableError(
          "Loyverse rejected the stored API key. Reconnect Loyverse in Settings.",
        );
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new TransientJobError(
            `Loyverse is rate limiting or unavailable (HTTP ${response.status}).`,
          );
        }
        await this.sleep(
          response.status === 429 ? retryAfterMs(response, attempt) : backoffMs(attempt),
        );
        continue;
      }
      if (!response.ok) {
        throw new TransientJobError(`Loyverse request failed (HTTP ${response.status}).`);
      }

      let body: LoyverseListResponse;
      try {
        body = (await response.json()) as LoyverseListResponse;
      } catch {
        throw new TransientJobError("Loyverse returned an unreadable response.");
      }
      const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
      const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
      return { items, cursor };
    }
  }
}
