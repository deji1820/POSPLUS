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

> Not yet implemented — Sprint 1 issues (see [GitHub Issues](https://github.com/deji1820/POSPLUS/issues)) cover scaffolding, the database schema, auth, and the Loyverse sync pipeline. Local dev will use `docker compose` (PostgreSQL, Redis, MinIO) per SPEC.md §23.
