# POSPLUS

**POSPLUS ("Loyverse+")** is a multi-tenant, web-based back-office/ERP layer connected to an existing [Loyverse](https://loyverse.com) POS account. It imports operational data from Loyverse, performs back-office accounting, procurement, manufacturing, workforce, and analytics workflows, and selectively writes approved stock-related changes back to Loyverse through the official API.

POSPLUS does **not** replace the POS used by store staff.

## Documentation

| File | Contents |
|---|---|
| [SPEC.md](SPEC.md) | Full application specification (architecture, API contract, data model, workflows, Definition of Done) |
| [AGENT.md](AGENT.md) | Agent/AI contributor guidelines |
| [BRAND.md](BRAND.md) | Brand and design language |
| [auto-dev.md](auto-dev.md) | Autonomous issue-processing loop |
| [docs/features.md](docs/features.md) | Running log of shipped features — append an entry per change |
| [docs/migrations.md](docs/migrations.md) | DB timestamp/migration conventions — read before any schema change |

## Stack

Next.js (App Router) · TypeScript · Prisma · PostgreSQL (Railway) · Redis + BullMQ · Tailwind CSS · Auth.js · S3-compatible storage · pnpm

## Development

Requires Node.js 24+ and pnpm 11+.

```bash
# 1. Start local infra (PostgreSQL, Redis, MinIO) — SPEC.md §23
docker compose up -d

# 2. Configure environment
cp .env.example .env
# Fill in at minimum:
#   DATABASE_URL=postgresql://posplus:posplus@localhost:5433/posplus
#   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ORG_NAME (SPEC.md §21)

# 3. Install, migrate, seed
pnpm install
pnpm db:deploy     # applies prisma/migrations (issue #2)
pnpm db:seed       # dev admin + test organization (issue #8)

# 4. Run
pnpm dev           # http://localhost:3000
```

Checks: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build`
