# Features Log

Running log of shipped features. **Append an entry here for every change** (required by `auto-dev.md`).

Format:

```markdown
## YYYY-MM-DD — Short title (#ISSUE)

- What changed (user-visible behavior, API, schema)
- Migration name if any (see docs/migrations.md)
- Notes / follow-ups
```

---

## 2026-09-09 — Repository setup (no code yet)

- Imported SPEC.md, AGENT.md, BRAND.md, auto-dev.md
- Added README.md, this features log, and migration conventions
- GitHub issues + sprint milestones created from SPEC.md (Sprints 1–5)

## 2026-09-09 — Monorepo scaffold (#1)

- Next.js 16 (App Router) + TypeScript 5.9 (strict) + pnpm + Tailwind CSS 4, full SPEC.md §4 directory tree (41 pages, 28 API route stubs, 7 management dashboard components, lib/ packages, prisma/, worker/, scripts/)
- Placeholder API routes return the SPEC.md §19 error envelope (`NOT_IMPLEMENTED`, 501); `/api/health` is live
- Tooling: ESLint 9 (`eslint-config-next` flat config), Prettier, Vitest (`tests/envelope.test.ts`), GitHub Actions CI (typecheck + lint + test)
- `.env.example` per SPEC.md §22; CHANGELOG.md records TS/ESLint pin decisions
- No migration (no schema yet — lands with #2)

## 2026-09-09 — Prisma schema, full domain model (#2)

- 68 tables covering every entity in SPEC.md §8: identity/tenancy, Loyverse integration, synced master data, finance (GL, journal, AP/AR), inventory/procurement, manufacturing, workforce, dashboard dimensions (incl. `SalesReferenceRule` default 3.3), audit/documents/outbox/idempotency
- Money `DECIMAL(14,2)`, quantities `DECIMAL(14,3)`; `organizationId` on all business records; org-scoped unique constraints on Loyverse IDs
- Prisma 7.10.0 (stable; 8.0 is RC) with new config model: `prisma.config.ts` + `@prisma/adapter-pg` driver adapter
- Initial migration `20260909000000_init` generated via `prisma migrate diff` (offline, reproducible via `pnpm db:deploy`); `pnpm exec prisma validate` enforced in CI via `tests/schema.test.ts`

## 2026-09-09 — Local dev environment: docker-compose + seed (#8)

- `docker-compose.yml` (SPEC.md §23): Postgres 16 (host port **5433** — 5432 is commonly taken by a local install), Redis 7, MinIO + `minio-init` bucket provisioning, healthchecks throughout
- `prisma/seed.ts`: dev admin (scrypt-hashed password; #3 Auth.js must reuse `verifyScryptPassword`), test org, Owner membership, example store + warehouse, 12-account baseline COA, baseline GL mappings (Cash/Card), example supplier (3-day lead time), example pay rule, `SalesReferenceRule` seeded at **3.3** (SPEC.md §8)
- Credentials strictly from env (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ORG_NAME`, §21); `pnpm db:seed` wired via `prisma.config.ts` migrations.seed
- Verified end-to-end against the live compose stack: `db:deploy` applied `20260909000000_init`; seed ran and is idempotent (re-run keeps row counts stable)
- README quickstart updated

## 2026-09-09 — Auth: signup, login, sessions via Auth.js credentials (#3)

- Auth.js v5 (next-auth 5.0.0-beta.32) with Credentials provider, JWT sessions, `/api/auth/[...nextauth]` route, `types/next-auth.d.ts` session augmentation (`user.id`)
- Passwords: Node `node:crypto` scrypt (`scrypt:salt:hash`) in `lib/auth/password.ts`; the same `hashPassword` is reused by the seed (#8) and the same `verifyScryptPassword` by the login path — one hashing implementation across seed and auth
- `lib/auth.config.ts`: edge-safe config subset (session/pages only, no providers) consumed by `middleware.ts` — keeps scrypt/`node:crypto` out of the Edge Runtime bundle; `lib/auth/index.ts` adds the Credentials provider for Node runtimes only
- `middleware.ts`: auth guard — anonymous users redirected to `/login`, logged-in users redirected away from `/login`/`/signup` to `/dashboard`
- Signup (`/signup` server action, zod-validated): creates Organization + User + Owner `OrganizationMembership` in one transaction, then redirects to `/login?registered=1`
- Login (`/login` server action + `useActionState` form): deliberately vague "Invalid email or password." per SPEC.md §18; Suspense boundary around `useSearchParams` for static prerender
- Rate limiting (SPEC.md §18): in-memory fixed-window limiter `lib/auth/rate-limit.ts`, 10 attempts / 5 min per email on login; Redis backing lands with #34
- `lib/db.ts`: lazy Proxy singleton — Prisma client only instantiated on first use so `next build` page-data collection works without `DATABASE_URL`
- Tests: `tests/password.test.ts` (4), `tests/rate-limit.test.ts` (4, fake-timer deterministic); full gate green (typecheck / lint / 11 tests / build)
- Verified end-to-end against the live compose stack (curl through the real Auth.js flow): credentials login → 302 `/dashboard` + session cookie; `/api/auth/session` returns `user.id`; authed `/dashboard` 200; authed `/login` → 307 `/dashboard`; anon `/dashboard` → 307 `/login`; wrong password → 302 `/login?error=CredentialsSignin` (no 500); smoke user cleaned up afterwards
- Requires `AUTH_SECRET` (SPEC.md §22, already in `.env.example`)
- No migration (uses #2 schema as-is)

## 2026-09-09 — Tenant isolation + RBAC with store/warehouse scope (#4)

- `lib/auth/permissions.ts`: module matrix per SPEC.md §5 — SETTINGS (Owner), FINANCE (Owner, Accountant), INVENTORY/PURCHASING/TRANSFERS (Owner, Store Manager, Warehouse Staff), PRODUCTION (Owner, Store Manager), WORKFORCE/PAYROLL (Owner, HR Admin), ANALYTICS (Owner, Store Manager, Accountant); fail-closed for unknown roles
- `lib/auth/session-context.ts`: resolves the #3 session into `{ userId, orgId, role, storeIds, warehouseIds }` — ACTIVE `OrganizationMembership` required (401 `AUTH_REQUIRED` / 403 `ORG_MEMBERSHIP_REQUIRED`); multi-org via `posplus_active_org` cookie validated against memberships (org switcher UI lands with #37)
- Store/warehouse scope: `UserStoreAccess`/`UserWarehouseAccess` rows are an *optional restriction* on STORE_MANAGER / WAREHOUSE_STAFF; scoped role with no rows = unrestricted within the org; other roles are org-wide
- `lib/auth/guard.ts`: `withAuth({ module, storeId?, warehouseId? }, handler)` for API routes (static + dynamic overloads; store/warehouse ids resolved from route params) and `requireModule(module)` for server actions; denials return the §19 envelope (`AUTH_REQUIRED` 401, `FORBIDDEN` 403, `STORE_SCOPE_DENIED` / `WAREHOUSE_SCOPE_DENIED` 403); handlers receive the context — every query must scope by `ctx.orgId` (§18)
- Reference pattern applied to three stub routes: `/api/finance/accounts` (FINANCE), `/api/purchasing/purchase-orders` (PURCHASING), `/api/workforce/employees` (WORKFORCE) — future issues wrap their routes the same way
- Tests: `tests/permissions.test.ts` (full role×module allow/deny matrix), `tests/guard.test.ts` (context resolution incl. cookie org selection, module denials, cross-org store rejection, warehouse scope, dynamic params, `requireModule`); full gate green (typecheck / lint / 38 tests / build)
- Verified end-to-end against the live compose stack: anon → 401 `AUTH_REQUIRED`; ACCOUNTANT → FINANCE gate passes (501 stub), PURCHASING and WORKFORCE → 403 `FORBIDDEN`; smoke user/org removed afterwards
- No migration (uses #2 schema as-is)

## 2026-09-09 — Loyverse connect + encrypted credential vault (#5)

- `lib/encryption.ts`: AES-256-GCM envelope encryption (`version:iv:tag:ciphertext`, base64) with the key from `ENCRYPTION_KEY` env (base64 or hex, 32 bytes) and versioned rotation — `KEY_VERSION` labels new envelopes, optional `ENCRYPTION_KEYS` JSON map keeps retired versions decryptable; plaintext never logged or returned (SPEC.md §18)
- `lib/loyverse/client.ts`: official-API-only key validation (`GET /v1.0/me`, Bearer auth, 10s timeout) distinguishing Loyverse 401/403 (`INVALID_LOYVERSE_API_KEY` 400) from network/provider failure (`LOYVERSE_UNAVAILABLE` 502)
- `lib/loyverse/connect.ts`: validate → encrypt → upsert `LoyverseConnection` (org-unique) + record a `QUEUED` INITIAL `SyncRun` in one transaction; responses sanitized — `encryptedApiKey` never leaves the server
- `POST /api/loyverse/connect` (SETTINGS-gated), `POST /api/loyverse/sync` (202 + QUEUED run; 409 `LOYVERSE_NOT_CONNECTED` otherwise), `GET /api/loyverse/sync/status` (sanitized status + last webhook + 10-run history)
- `/settings/loyverse` page (SPEC.md §6): status badge, key version, last successful sync, last webhook, manual "Sync now", operator-safe sync history table, connect/replace-key form (server actions share the same lib as the API); SETTINGS module is Owner-only per the §5 matrix
- Migration `20260909001000_sync_run_queued`: `QUEUED` added to `SyncRunStatus` so accepted jobs are recorded honestly before the BullMQ worker (#6) and sync implementations (#7) land
- Also fixed a latent #4 bug found by this issue's routes: Next 16 passes a route context object to **every** route handler, so the guard's static-vs-dynamic dispatch now keys on the *presence of `params`* (was: presence of the context) — the three #4 reference routes only worked because their handlers ignored arguments; regression test added
- Tests: `tests/encryption.test.ts` (11: roundtrip, envelope shape, random IV, hex keys, wrong-key/tamper detection, rotation via `ENCRYPTION_KEYS`, misconfiguration), `tests/loyverse-connect.test.ts` (12: validation mapping, envelope-at-rest + decryptability, sanitization, QUEUED run, org scoping); full gate green (typecheck / lint / 62 tests)
- Verified end-to-end against the live compose stack: anon → 401; bad key → 400 `INVALID_LOYVERSE_API_KEY` (real Loyverse API); malformed body → 400; sync while disconnected → 409; connected status → 200 sanitized (key material absent); sync → 202 `QUEUED` (MANUAL + INCREMENTAL) and visible in history; page renders with plaintext key absent from HTML; ACCOUNTANT → 403 on API and page; smoke users/connection/runs removed afterwards

## 2026-09-09 — Background job infra: Redis + BullMQ worker (#6)

- `lib/queue/queues.ts`: all eight SPEC.md §10 queues (`loyverse-webhooks`, `loyverse-sync`, `finance-posting`, `inventory`, `reorder`, `payroll`, `documents`, `analytics`) with the §10 job→queue registry, lazy queue instances (importing never opens Redis), and the §19 retry policy (5 attempts, exponential backoff, failed jobs retained 7 days as the dead-letter path)
- `worker/index.ts`: standalone worker (`pnpm worker`, Railway-deployable per §3) — one BullMQ Worker per queue, per-queue concurrency, JSON job lifecycle logs with correlation IDs, durations, and dead-letter markers (§24), graceful SIGINT/SIGTERM drain; `worker/registry.ts` maps job names to processors, permanent not-implemented stubs dead-letter unknown job types with a safe reason
- `worker/processors/loyverse-sync.ts`: owns the SyncRun QUEUED → RUNNING → COMPLETED/FAILED state machine — the sync engine is injectable, #6 ships a permanent "lands with #7" stub that records a safe FAILED summary on the run (no queue retries); transient engine errors are recorded on the run AND rethrown so BullMQ retries with backoff; cross-tenant or missing runs dead-letter permanently
- `lib/queue/errors.ts`: `TransientJobError` (retry) vs BullMQ `UnrecoverableError` (dead-letter) taxonomy; `safeJobErrorMessage` only preserves messages of errors we raise ourselves — anything else becomes a generic operator-safe message (no SQL/stack leakage, §19)
- `lib/queue/enqueue.ts`: web→worker handoff — `POST /api/loyverse/sync`, the settings Sync-now action, and `connectLoyverse` (post-transaction) all schedule their QUEUED run with a deterministic jobId (`sync-<runId>`); an unreachable queue marks the run FAILED with a safe summary and surfaces 503 `QUEUE_UNAVAILABLE` instead of leaving a run nothing will consume
- Operator retry controls (§19): `GET /api/jobs/failed?queue=<name>` lists dead-lettered jobs (id, name, attempts, safe reason) and `POST /api/jobs/retry` re-queues one — both Owner-only (SETTINGS), zod/queue-name validated, `JOB_NOT_FOUND` 404
- Deps: `bullmq` 6.3.4 + explicit `ioredis` 6.0.0 (BullMQ 6 optional peer) — recorded in CHANGELOG.md; `pnpm worker` script added
- Tests: `tests/queue.test.ts` (registry completeness, REDIS_URL parsing, stub routing), `tests/loyverse-sync-processor.test.ts` (lifecycle incl. permanent/transient handling, cross-tenant dead-letter, summary redaction), `tests/jobs-admin.test.ts` (dead-letter listing + retry control with mocked queue); #5's connect tests updated to mock the enqueue + new cases for scheduling and QUEUE_UNAVAILABLE; full gate green (typecheck / lint / 84 tests)
- Verified end-to-end against the live compose stack (worker + dev server running): login → `POST /api/loyverse/sync` 202 QUEUED → worker picked the job up (log: job started/completed, correlation id, durationMs) → status API shows the run FAILED with the honest "#7 stub" summary — full web→worker round trip; a deliberately failing `process-loyverse-webhook` job dead-lettered with `attemptsMade: 1` and safe reason via `GET /api/jobs/failed`; `POST /api/jobs/retry` re-queued it (attempt 2 recorded); anon → 401, bad queue → 400, missing job → 404, malformed body → 400; smoke user/org/connection/runs and BullMQ smoke queues removed afterwards
- Follow-ups: #7 replaces the sync engine stub (initial/incremental implementations registered in `worker/registry.ts`); nightly repeatable schedules land with the jobs that need them (§10 Scheduling); remaining queue processors register as their domain issues land
