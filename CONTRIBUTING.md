# Contributing to recto

Thanks for your interest in improving recto. This guide gets you from clone to
pull request.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.

## Getting started

```bash
git clone https://github.com/eikiyo/recto.git
cd recto/recto
pnpm install
cp apps/workers/api/.dev.vars.example apps/workers/api/.dev.vars   # fill in your keys
pnpm --filter @recto/api db:generate
pnpm --filter @recto/api db:migrate:local
pnpm dev:api    # API on :8787
pnpm dev:web    # static UI on :8765
```

Requirements: **Node ≥ 20** and **pnpm 9**. (`wrangler` is a dev dependency,
installed by `pnpm install` — no global install needed.)

## Before you open a PR

Run the full local gate from `recto/`:

```bash
pnpm --filter @recto/api typecheck   # strict TypeScript, zero errors
pnpm --filter @recto/api lint        # ESLint + brand-voice rules
pnpm --filter @recto/api test        # vitest: unit, property, chaos
```

For UI changes, run the audit suite in `recto-ui/tests/` (Playwright):

```bash
cd ../recto-ui/tests && pnpm install && pnpm exec playwright test
```

CI runs all of the above on every PR. A PR must be green to merge.

## Conventions

- **TypeScript strict mode** everywhere; no `any` escape hatches without a comment.
- **Validation at the boundary** — request/response shapes are zod schemas in
  `packages/shared`. Don't trust unvalidated input.
- **One source of truth for data** — schema changes go through Drizzle migrations
  in `packages/db` / `apps/workers/api/src/db/migrations`. Migrations are
  **additive**; never edit a shipped migration.
- **Brand voice** — user-facing copy is linted. The voice gate fails on banned
  words and hook anti-patterns; see `packages/eslint-recto`.
- **Commits** — clear, imperative subject lines (e.g. `fix: handle 406 from Wordfence`).
  Conventional Commit prefixes are encouraged but not required.
- **Never commit secrets.** `.dev.vars` is git-ignored. If you add a new env var,
  document it in `apps/workers/api/.dev.vars.example` in the same PR.

## Pull request process

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep PRs focused — one logical change per PR.
3. Add or update tests for behavior changes.
4. Update docs / `.dev.vars.example` / `CHANGELOG.md` as needed.
5. Fill out the PR template and ensure CI is green.

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
