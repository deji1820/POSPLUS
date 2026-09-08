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
