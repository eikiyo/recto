# recto — backend

The production monorepo for **recto**: orphan-page rescue and internal-link
insertion for WordPress and Webflow. One-time purchase, no subscription.

> This is the backend package. For the product overview, architecture diagram,
> and quickstart see the [repository README](../README.md). The audited static
> UI lives one directory up under [`recto-ui/`](../recto-ui/).

## Stack

Cloudflare-only:

- **Workers** for the API (Hono)
- **D1** SQLite for OLTP
- **Vectorize** for embeddings (namespaced per site)
- **KV** for sessions and rate limits
- **R2** for cold blobs
- **Queues** for crawl / embed / push / verify / email jobs
- **Cron Triggers** for the weekly digest and the credit sweep
- **Workers AI** for the embedding floor (BGE) and anchor-gen floor (Llama 3.1 8B)
- **Browser Rendering** only when a site requires JS to render
- **Emailit / Resend / MailChannels** for transactional email (tried in that order)

## Repo layout

```
recto/
├── apps/
│   ├── web/          # Pages bundle — static UI shell (mirrors ../recto-ui/)
│   └── workers/
│       └── api/      # Hono app on Workers
├── packages/
│   ├── db/           # Drizzle (D1 dialect) schema and migrations
│   ├── shared/       # zod schemas, constants, types
│   └── eslint-recto/ # voice + hook-pattern lint rules
├── load/             # k6 load scripts
├── scripts/          # smoke / integration / fuzz / deploy
├── ops/runbooks/     # operational runbooks (GSC OAuth setup)
└── tests/            # persona gate (the full UI audit harness lives in ../recto-ui/tests)
```

## Local dev

```bash
pnpm install
cp apps/workers/api/.dev.vars.example apps/workers/api/.dev.vars   # then fill in keys
pnpm --filter @recto/api db:generate
pnpm --filter @recto/api db:migrate:local
pnpm dev:api    # wrangler dev on :8787
pnpm dev:web    # python http.server on :8765 serving the static UI
```

## Deploy

Create the Cloudflare resources, paste their IDs into
[`apps/workers/api/wrangler.toml`](apps/workers/api/wrangler.toml) (search for
`REPLACE_WITH_`), set the secrets with `wrangler secret put`, then deploy.
CI runs typecheck, lint, vitest, and the voice gate on every PR
(see [`.github/workflows/`](../.github/workflows/)).
