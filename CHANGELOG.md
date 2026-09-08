# Changelog

Records major-version dependency/upgrade decisions per SPEC.md §3. Day-to-day shipped features are logged in `docs/features.md`.

## 2026-09-09 — Initial scaffold (issue #1)

- Next.js 16.3.4 (App Router) + React 19.2.8 + TypeScript 5.9.3, strict mode
- Tailwind CSS 4.3.3 via `@tailwindcss/postcss`
- ESLint 9.39.5 (`eslint-config-next` flat config), Prettier 3.9.6, Vitest 5.0.0
- Versions locked in `pnpm-lock.yaml`; resolved versions are the latest stable at scaffold time

### Upgrade decisions

- **TypeScript pinned to ^5.9** (not 7.0.2): `typescript-eslint` (via `eslint-config-next`) does not support the TS 7 line yet. Revisit when `eslint-config-next` bumps its `typescript-eslint`.
- **ESLint pinned to ^9.39** (not 10.10.0): `eslint-plugin-react` 7.37.5 (latest; required by `eslint-config-next@16.3.4`) still uses `context.getFilename()`, removed in ESLint 10. Revisit when `eslint-plugin-react` ships ESLint 10 support.
- **Prisma pinned to 7.10.0** (not 8.0.0-rc.x): the `latest` dist-tag points at an 8.0 release candidate; per SPEC.md §3 we take the newest **stable** line. Prisma 7 moves the connection URL out of `schema.prisma` into `prisma.config.ts` and requires driver adapters (`@prisma/adapter-pg`) — the new config model is adopted here.
- **next-auth pinned to 5.0.0-beta.32** (exact): v5 is still in beta and breaking changes land between betas, so we pin the exact version rather than a range per SPEC.md §3 (newest stable/beta acceptable when no stable exists). Revisit when v5 goes stable. `zod` added for server-action input validation.
