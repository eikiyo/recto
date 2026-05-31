// Programmatic auth helper for Playwright specs.
//
// The SPA's data pages are auth-gated. Specs use this helper to obtain a
// real session cookie via the same magic-link round-trip an actual user
// follows. Works against wrangler dev only — the dev mode of the magic
// route returns `devToken` so we can complete the callback in-band.

import type { Page, BrowserContext } from '@playwright/test';

const API = 'http://localhost:8787';

export async function loginAs(ctxOrPage: BrowserContext | Page, email = 'eikiyo@recto.so'): Promise<void> {
  // Resolve to a context: Page has .context(); a BrowserContext exposes itself.
  const context: BrowserContext =
    'context' in ctxOrPage ? (ctxOrPage as Page).context() : (ctxOrPage as BrowserContext);

  // Use a request fetcher anchored to the API so cookies survive into the
  // context's storage.
  const request = context.request;
  const res = await request.post(`${API}/api/auth/magic`, { data: { email } });
  const body = await res.json();
  if (!body || !body.devToken) {
    throw new Error('loginAs: no devToken in /api/auth/magic response — is RECTO_ENV=dev?');
  }
  // The callback redirects to the SPA workbench with the session cookie set.
  // We disable redirect-following so Playwright records the Set-Cookie header.
  const cb = await request.get(`${API}/api/auth/callback?token=${body.devToken}`, { maxRedirects: 0 });
  if (cb.status() !== 302 && cb.status() !== 301) {
    throw new Error(`loginAs: callback returned ${cb.status()}, expected redirect`);
  }
}

// Find a fixture site this user can act against. Order of attempts:
//   1. `/tmp/recto-site-id` (the prod-grade tour writes this)
//   2. The first site `/api/sites` returns for the calling session
// Specs use `test.skip(!siteId, ...)` to gracefully bail when no fixture
// is reachable.
export async function seedFixtureSite(ctxOrPage?: BrowserContext | Page): Promise<{ siteId: string | null }> {
  try {
    const fs = await import('node:fs/promises');
    const id = (await fs.readFile('/tmp/recto-site-id', 'utf8')).trim();
    if (id) return { siteId: id };
  } catch {
    /* fall through */
  }
  if (ctxOrPage) {
    const ctx: BrowserContext = 'context' in ctxOrPage ? (ctxOrPage as Page).context() : (ctxOrPage as BrowserContext);
    try {
      const r = await ctx.request.get(`${API}/api/sites`);
      if (r.ok()) {
        const body = await r.json();
        const first = (body.sites || [])[0];
        if (first?.id) return { siteId: first.id };
      }
    } catch {
      /* ignore */
    }
  }
  return { siteId: null };
}
