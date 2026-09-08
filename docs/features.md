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
