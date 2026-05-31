<div align="center">

<img src="recto-ui/assets/logo-512.svg" alt="recto" width="96" height="96">

# recto

**Find the pages your site forgot — and the exact paragraph that should link to them.**

Orphan-page rescue and internal-link insertion for serious WordPress and Webflow sites. Built entirely on the Cloudflare developer platform.

[![CI](https://github.com/eikiyo/recto/actions/workflows/ci.yml/badge.svg)](https://github.com/eikiyo/recto/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built on Cloudflare Workers](https://img.shields.io/badge/built%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## What it does

A growing site quietly accumulates **orphan pages** — published URLs that nothing else links to. Search engines struggle to find them, and the traffic they could earn leaks away.

`recto` reads every page you have published, finds the orphans, ranks them by **lost Google Search Console impressions**, and shows you the **exact paragraph** on another page where an internal link belongs. You approve each suggestion; `recto` pushes the link through your CMS's REST API so it lives in the published HTML and survives even if you stop using the tool.

- **You stay in the seat.** recto suggests, you approve. Every change is yours.
- **Ranked by real traffic.** Orphans sorted by GSC impressions, not page depth.
- **Links that persist.** Pushed via the CMS API into published HTML — no shadow DB, no lock-in.
- **Bring your own key.** Paste an OpenAI/Anthropic key and route anchor generation through it.

## How it works

1. **Connect a site** — WordPress Application Password or Webflow API key.
2. **Connect Google Search Console** (optional) — ranks orphans by traffic.
3. **Read the site** — one crawl pass, up to 10,000 pages.
4. **Surface the orphans** — ranked list, most valuable first.
5. **Insert the link** — pick a candidate paragraph; recto pushes it through the CMS API.
6. **Re-read on a schedule** — weekly by default; new orphans surface as you publish.

## Repository layout

This is a monorepo with two top-level packages:

```
.
├── recto/        # The backend — pnpm/Cloudflare monorepo
│   ├── apps/
│   │   ├── workers/api/   # Hono API on Cloudflare Workers
│   │   └── web/           # static Pages bundle (mirror of recto-ui)
│   ├── packages/
│   │   ├── db/            # Drizzle (D1 dialect) schema + migrations
│   │   ├── shared/        # zod schemas, constants, shared types
│   │   └── eslint-recto/  # brand-voice + hook-pattern lint rules
│   ├── load/             # k6 load scripts
│   ├── scripts/          # smoke / integration / fuzz / deploy
│   └── ops/runbooks/     # operational runbooks (e.g. GSC OAuth setup)
└── recto-ui/     # The frontend — audited static UI (landing + app shell)
    ├── app/              # signed-in app screens (vanilla HTML/CSS/JS)
    ├── styles/           # design tokens + components
    └── tests/            # Playwright persona, a11y, and visual-baseline gates
```

## Architecture

Cloudflare-only. No servers, no containers.

| Concern | Cloudflare primitive |
|---|---|
| API | **Workers** (Hono) |
| Relational data (OLTP) | **D1** (SQLite) |
| Embeddings / similarity | **Vectorize** |
| Sessions, rate limits, ETag cache | **KV** |
| Cold blobs (audit archive) | **R2** |
| Async jobs (crawl / embed / push / verify / email) | **Queues** |
| Scheduled work (digests, credit reset) | **Cron Triggers** |
| Embedding + anchor-generation floor | **Workers AI** (BGE, Llama 3.1 8B) |
| JS-rendered pages | **Browser Rendering** |
| Crawl progress (SSE) | **Durable Objects** |
| Transactional email | Emailit → Resend → **MailChannels** fallback |

## Quickstart

> Prerequisites: **Node ≥ 20**, **pnpm 9**, and a free **Cloudflare account**.
> `wrangler` is already a dev dependency — `pnpm install` brings it in, no global install needed.

```bash
# 1. Clone and install
git clone https://github.com/eikiyo/recto.git
cd recto/recto
pnpm install

# 2. Configure local secrets
cp apps/workers/api/.dev.vars.example apps/workers/api/.dev.vars
#    → open .dev.vars and fill in your own keys (see comments in the file)

# 3. Create the local D1 database + run migrations
pnpm --filter @recto/api db:generate
pnpm --filter @recto/api db:migrate:local

# 4. Run it — one command starts both the API and the static UI
pnpm dev        # API on http://localhost:8787 + UI on http://localhost:8765
                # (Ctrl-C stops both. Prefer separate terminals? Run
                #  `pnpm dev:api` and `pnpm dev:web` individually.)
```

Health check:

```bash
curl http://localhost:8787/api/health
# → {"status":"ok","checks":{"env":"dev","db":"bound","kv":"bound",...,"dbPing":"ok"},"ts":...}
```

To deploy your own instance, create the Cloudflare resources and paste their IDs into `recto/apps/workers/api/wrangler.toml` (search for `REPLACE_WITH_`):

```bash
cd recto
pnpm exec wrangler d1 create recto
pnpm exec wrangler kv namespace create KV
# then set production secrets:
pnpm exec wrangler secret put RECTO_KEK
pnpm exec wrangler secret put MAGIC_LINK_SECRET
# …etc (see apps/workers/api/.dev.vars.example for the full list)
```

## Configuration

All runtime configuration is environment-driven. The single source of truth is
[`recto/apps/workers/api/.dev.vars.example`](recto/apps/workers/api/.dev.vars.example),
which documents every variable the Worker reads and where to obtain it. Non-secret
bindings (D1, KV, Queues, R2, Vectorize, AI) are declared in
[`recto/apps/workers/api/wrangler.toml`](recto/apps/workers/api/wrangler.toml).

The Google Search Console OAuth setup is the one manual step — a full walkthrough lives in
[`recto/ops/runbooks/gsc-setup.md`](recto/ops/runbooks/gsc-setup.md).

## Testing

```bash
cd recto
pnpm --filter @recto/api typecheck   # strict TypeScript
pnpm --filter @recto/api lint        # ESLint + brand-voice rules
pnpm --filter @recto/api test        # vitest: unit, property, chaos
bash scripts/smoke.sh                # API smoke test (needs wrangler dev running)
```

The frontend ships its own audited Playwright suite (persona simulations,
accessibility, and visual-baseline snapshots) under `recto-ui/tests/`.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md) first. Security reports go through the
process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Eikiyo
