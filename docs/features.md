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
