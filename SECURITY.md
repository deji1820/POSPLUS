# Security runbook

How POSPLUS protects secrets, tenants, and the public edge — and how to
operate it safely. This is the operator-facing companion to SPEC.md §18
("Security") and §24 ("Audit & logging"). Issue #34 made every control below
verifiable; §"Verifying" shows how to re-check them.

## 1. Secrets management

**Nothing sensitive is committed.** `.env.example` lists variable *names* and
non-secret shape only; real values live in the deployment environment (CI/CD
secrets, or a local `.env` that is git-ignored). If you ever see a key,
token, or password land in the repo, treat it as compromised and rotate it
(§2).

### Encryption at rest

Loyverse API credentials (`LoyverseConnection.encryptedApiKey`) are encrypted
with **AES-256-GCM** before they touch the database. Key material comes only
from the environment — never the database — via `lib/encryption.ts`:

| Env var         | Meaning                                                            |
|-----------------|-------------------------------------------------------------------|
| `ENCRYPTION_KEY` | Current 32-byte key, base64 (44 chars) or hex (64 chars).        |
| `KEY_VERSION`    | Current version label, e.g. `v1`. Default `v1`.                   |
| `ENCRYPTION_KEYS`| JSON map of **retired** versions kept for decryption, e.g. `'{"v1":"<old-key>"}'`. |

The stored envelope is self-describing: `<version>:<iv>:<authTag>:<ciphertext>`.
The version prefix lets the app decrypt rows written under an older key after
rotation, without a data migration. Plaintext is never logged and never
leaves `lib/encryption.ts` unencrypted.

### Webhook secrets

Loyverse webhooks authenticate by HMAC — there is no shared password to
steal, only the signing secret used to *verify*. Per SPEC §18/§25, signature
verification happens on the **raw body before any parsing**; a mismatch is a
401 and the body is never interpreted. Verification is constant-time. The
secret lives only in `LOYVERSE_WEBHOOK_SECRET` and is never logged, echoed,
or persisted.

## 2. Key rotation

Rotation is a two-step process: deploy the new key, then re-encrypt stored
rows onto it. Because envelopes are versioned, step 1 alone keeps the app
working (old rows still decrypt); step 2 removes the retired key from service.

1. **Generate a new key** (32 bytes, base64):
   ```bash
   openssl rand -base64 32
   ```
2. **Deploy** with the new key promoted and the old key retired:
   - `ENCRYPTION_KEY` = the new base64 key
   - `KEY_VERSION` = a new label, e.g. `v2`
   - `ENCRYPTION_KEYS` = `'{"v1":"<old-base64-key>"}'` (so v1 rows still decrypt)
3. **Re-encrypt** all stored Loyverse credentials onto the new key:
   ```bash
   # preview what would change
   pnpm rotate-keys:dry-run
   # apply
   pnpm rotate-keys
   ```
   The script (`scripts/rotate-encryption-key.ts`) walks every
   `LoyverseConnection`, skips rows already on the current version, and
   decrypts-with-old / re-encrypts-with-new the rest. Per-row failures are
   reported and leave that row untouched (exit code 1 if any fail).
4. **Retire the old key.** Once every row reports `already on v2`, drop the
   old entry from `ENCRYPTION_KEYS` at the next deploy.

### Rotation walkthrough (dev)

The compose stack makes this safe to practice end-to-end. Bring up postgres,
seed a connection, rotate, verify:

```bash
docker compose up -d postgres
pnpm db:migrate && pnpm db:seed
# current envelopes are v1 (seed sets KEY_VERSION=v1)
pnpm rotate-keys:dry-run          # reports "N would re-encrypt … v1 → v2"

# simulate a deploy: promote a fresh key, retire the old one
export ENCRYPTION_KEY="<new-base64-32-bytes>"
export KEY_VERSION=v2
export ENCRYPTION_KEYS='{"v1":"<old-base64-32-bytes>"}'

pnpm rotate-keys                  # re-encrypts v1 rows → v2
pnpm rotate-keys:dry-run          # now reports "already on v2" — done
```

Verification that rotation actually worked: the app can still decrypt and use
each credential (a Loyverse sync succeeds), and `select substring(encrypted_api_key from 1 for 2) from "LoyverseConnection"` shows `v2:` prefixes.

## 3. Webhook signature & replay protection

The public webhook endpoint (`POST /api/loyverse/webhook`) is defended in
layers, all enforced *before* the payload is trusted:

1. **Rate limit** — 60 requests/min per source IP (§22). Shared across all
   web replicas via Redis.
2. **Signature verification on the raw body** — `x-loyverse-signature`
   (lowercase hex HMAC-SHA1 of the exact raw body) or `Authorization: Bearer
   <secret>` fallback. Constant-time compare. Mismatch → 401.
3. **Schema validation** — the event must carry `merchant_id`, `type`, and
   `created_at`; otherwise 400. Resource arrays pass through after the
   envelope validates.
4. **Tenant attribution from our own rows** — the org is resolved from
   `merchant_id`/`store_id` matched against *our* `LoyverseConnection`/`Store`
   records, never from trusting an org id supplied in the body. Unknown
   business → 200 ack, dropped.
5. **Replay protection** — event identity is the SHA-256 of the raw body,
   stored as a unique `(organizationId, externalEventId)` pair. An exact
   replay collides and is acked with `duplicate: true` **without** re-enqueueing.

Bodies are never logged — only the event id, type, and hash (§24).

## 4. Rate limiting

Fixed-window limiter in `lib/auth/rate-limit.ts`, **Redis-backed** so the
limit is shared across every web process (the earlier in-memory version reset
on replica restart and allowed N×replicas abuse). Redis unreachable →
degrades to a per-process in-memory limiter, never fails auth open or closed,
and logs the degradation once. `RATE_LIMIT_BACKEND=memory` forces the
in-memory path (tests, local scripts without Redis).

| Surface                          | Limit                    | Scope        |
|----------------------------------|--------------------------|--------------|
| Login (`authorize`)              | 10 / 5 min (defaults)    | per email    |
| Auth catch-all POST (callback/sign-out) | 30 / min          | per source IP |
| Public webhook endpoint          | 60 / min                 | per source IP |

Denials return the §19 envelope with code `RATE_LIMITED` and HTTP 429.

## 5. Web security posture

- **CSRF** — Auth.js issues and checks CSRF tokens on the credentials
  callback; sign-in/out POSTs require a valid token. SameSite=Lax session
  cookies. We do not implement custom state-changing GETs.
- **Cookies** — session cookie is `Secure` and `HttpOnly` whenever the app is
  served over HTTPS (`AUTH_URL` is an `https://` origin); `HttpOnly` always.
- **Security headers** (every response, pages and APIs alike — set in
  `next.config.ts`, since middleware excludes API routes):
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY` (clickjacking; the app never frames itself)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy` — self-contained app: `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'` (+ `'unsafe-eval'` in dev for HMR),
    `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`,
    `font-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'`,
    `base-uri 'self'`, `form-action 'self'`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
    — **production only** (don't force HTTPS redirects on localhost dev).
- **Schema validation everywhere** — every request body and query is parsed
  with zod before use; invalid input is a 400, never executed.
- **Parameterized queries only** — all DB access goes through Prisma; there is
  no raw SQL built from user input (`$queryRaw` does not appear in the app).

## 6. Verifying

Re-check the controls any time the edge changes:

```bash
# headers on any response (dev server)
curl -sI http://localhost:3000/ | grep -iE 'x-frame|x-content|strict-transport|content-security|referrer|permissions'

# webhook rate limit: 61 rapid POSTs from one IP → the last is 429
# replay: POST the identical signed body twice → second is 200 duplicate:true
# auth POST limit: 31 rapid callback POSTs → 429 RATE_LIMITED
```

Unit/integration coverage: `tests/rate-limit.test.ts` (limiter semantics +
degradation), `tests/loyverse-webhook-route.test.ts` (signature-before-parse,
replay, rate limit, §24 logging hygiene), `tests/encryption.test.ts` (key
ring, rotation, tamper detection).
