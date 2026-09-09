# Migration Conventions

Read this before any schema change. Required by `auto-dev.md`.

## Database

- PostgreSQL, accessed via Prisma ORM only. Never build raw SQL from user input (SPEC.md §18).
- Money and quantity columns use decimal types — never `Float` (SPEC.md §18).

## Workflow

1. Edit `prisma/schema.prisma`.
2. Generate a migration with a descriptive name:
   ```bash
   pnpm prisma migrate dev --name describe_change
   ```
3. Migration names: snake_case, imperative, e.g. `add_purchase_order_approvals`, `seed_sales_reference_rule`.
4. Never edit an existing migration that has been applied anywhere (including teammates' machines or Railway). Create a new one instead.
5. Every migration must be reproducible from a fresh database (`pnpm prisma migrate deploy` against an empty DB must succeed).

## Tenant discipline (SPEC.md §5, §8)

- Every business-domain table must be reachable from `organizationId` directly or through an unambiguous parent relation.
- External Loyverse identifiers carry unique constraints scoped to the relevant organization.
- Immutable financial records (posted journal entries, payroll runs) support no destructive migrations that rewrite history — model corrections as new records/reversals.

## Seeding

- `prisma/seed.ts` provides baseline data (roles, chart of accounts, example org). Credentials come from environment variables only (SPEC.md §21).

## Log

| Date | Migration | Notes |
|---|---|---|
| 2026-09-09 | `20260909000000_init` | Full §8 domain model — 68 tables, initial baseline |

Note: Prisma 7 config lives in `prisma.config.ts` (connection URL is no longer in `schema.prisma`). Prisma CLI commands require `DATABASE_URL` to be set — export it or use `.env` with your shell.
