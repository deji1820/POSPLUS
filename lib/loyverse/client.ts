/**
 * Minimal Loyverse API client (official API only — SPEC.md "Do not scrape
 * Loyverse or depend on undocumented endpoints"). Credential validation
 * lives here; the paginated sync read client lives in lib/loyverse/http.ts
 * and the sync engine in lib/loyverse/sync/ (#7).
 */
export const LOYVERSE_API_BASE = "https://api.loyverse.com/v1.0";

/**
 * Base URL for all Loyverse calls. Overridable via LOYVERSE_API_BASE for
 * integration testing against a stub server (never set in production).
 */
export function loyverseApiBase(): string {
  return process.env.LOYVERSE_API_BASE?.trim() || LOYVERSE_API_BASE;
}

const VALIDATE_TIMEOUT_MS = 10_000;

export type ValidateKeyResult =
  | { ok: true; businessName: string | null; merchantId: string | null }
  | { ok: false; reason: "invalid" | "unavailable" };

/**
 * Validate an API key against Loyverse server-side. Never logs the key.
 * Distinguishes "Loyverse rejected the key" (401/403) from "could not reach
 * Loyverse" so callers can return the right error to the operator. The
 * merchant id from /me is returned so connect can persist it — webhook
 * payloads carry merchant_id and routing needs the mapping (#9).
 */
export async function validateApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidateKeyResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${loyverseApiBase()}/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "invalid" };
  }
  if (!response.ok) {
    return { ok: false, reason: "unavailable" };
  }

  let body: { name?: unknown; id?: unknown } | null = null;
  try {
    body = (await response.json()) as { name?: unknown; id?: unknown };
  } catch {
    // A 200 with a non-JSON body is unusual but still proves the key works.
  }
  return {
    ok: true,
    businessName: typeof body?.name === "string" ? body.name : null,
    merchantId: typeof body?.id === "string" ? body.id : null,
  };
}
