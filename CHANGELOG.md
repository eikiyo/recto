# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-06-07

A documentation-only release that brings the README visuals current with the
de-monetized UI shipped in 1.2.0. No code or behavior changes.

### Fixed
- Regenerated every app screenshot (`app-workbench`, `app-orphans`,
  `app-insertion`, `app-audit`) and the demo GIF from the current UI driven
  against a seeded local backend. The previous assets predated de-monetization
  and still showed the removed billing navigation and credit/site-cap copy.
- Corrected the Screenshots caption, which incorrectly described the app shots
  as empty-state shells captured without a backend; they are seeded captures.

## [1.2.0] - 2026-06-07

This release brings the public repository current with the product and ships it
as a **clean, unlimited self-hosted tool** — all hosted-only monetization has
been removed. Connect as many sites as you like; there are no credits, caps, or
billing of any kind.

### Removed
- **All monetization.** Stripe billing, AppSumo redemption + licensing, the
  anchor-credit metering system, trial windows, and per-site caps are gone. recto
  is now unlimited when self-hosted.
- Monthly credit-reset and reconciliation cron triggers.
- `welcome`, `tier-upgrade`, and credit-threshold transactional email templates
  (and their preview entries).
- The in-app billing screen, billing navigation, and the credit/license displays
  in settings.

### Added
- **Anchor selection that wraps a phrase you already published.** Instead of
  generating new copy, recto picks a verbatim phrase from a related post and
  turns that exact phrase into the link — your sentences stay as written. The
  model selects; it never authors.
- Onboarding flow and a guided "quick wins" path into the workbench.

### Changed
- **Bring-your-own-key (BYOK) is now purely about your AI key, not billing.**
  Paste an OpenAI/Anthropic key to route anchor generation through it; Workers AI
  is the default generator with no cap. Encrypted key storage is unchanged.
- Settings now shows your account email and connected-site count in place of the
  former license/credit panel.

### Fixed / Hardened
- Crawl, push, verify, and auth paths hardened: D1 bind-parameter sanitization,
  atomic dedup/idempotency on site connect and CMS push, boundary-safe URL and
  HTML-tag matching, content-path crawl gating, bounded queue poison handling,
  and Google Search Console join/perf fixes.

## [1.1.0] - 2026-05-31

### Added
- Initial public open-source release of the recto monorepo.
- `recto/` backend: Hono API on Cloudflare Workers with D1, KV, Vectorize, R2,
  Queues, Durable Objects, Workers AI, Cron Triggers, and Browser Rendering.
- Crawl → embed → orphan-detection → anchor-generation → CMS-push → verify pipeline.
- WordPress and Webflow CMS integrations; Google Search Console impression ranking.
- Magic-link (passwordless) authentication and envelope-encrypted credential storage.
- `recto-ui/` frontend: audited static landing site + signed-in app shell, with a
  Playwright persona, accessibility, and visual-baseline test suite.
- Brand-voice ESLint plugin and CI voice gate.
- Community-health files, CI workflows, and clone-and-go setup.

[1.2.0]: https://github.com/eikiyo/recto/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/eikiyo/recto/releases/tag/v1.1.0
