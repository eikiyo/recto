# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through either channel:

1. **GitHub private advisory** (preferred) — go to the
   [Security tab](https://github.com/eikiyo/recto/security/advisories/new) and
   open a draft advisory.
2. **Email** — `syedmosayebalam@gmail.com` with the subject line `recto security`.

Please include:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit, and
- any suggested remediation.

## What to expect

- **Acknowledgement** within 72 hours.
- An assessment and a remediation timeline once the report is triaged.
- Credit in the release notes when the fix ships, unless you prefer to remain anonymous.

Please give us a reasonable window to release a fix before any public disclosure.

## Scope

recto handles CMS credentials and OAuth tokens. Reports touching credential
storage/encryption (the envelope KEK flow), the magic-link auth path, webhook
signature verification, or CMS write operations are especially valued.

## Handling secrets

This repository ships **no live credentials**. All secrets are supplied at
runtime via `.dev.vars` (local) or `wrangler secret put` (production). If you
ever find a real key committed to this repo, treat it as compromised and report
it immediately so it can be rotated.
