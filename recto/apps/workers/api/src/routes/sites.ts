import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { ulid } from '../lib/ids';
import { encrypt } from '../lib/crypto';
import { requireSession, type AuthVars } from '../auth/middleware';
import { SITE_CAP_PER_CODE } from '@recto/shared';
import { discoverSitemap } from '../lib/sitemap';

export const sitesRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
sitesRouter.use('*', requireSession);

// Field caps: tight enough to defeat DoS/oversize payloads, generous enough
// for legitimate inputs. WP App Passwords are 24 chars + 5 spaces.
const ConnectBody = z.object({
  url: z.string().url().max(2048).refine(
    (u) => {
      try { const parsed = new URL(u); return parsed.protocol === 'https:' || parsed.protocol === 'http:'; }
      catch { return false; }
    },
    { message: 'url must be http(s)' }
  ),
  cms: z.enum(['wordpress', 'webflow']),
  wp_username: z.string().min(1).max(256).optional(),
  wp_app_password: z.string().min(1).max(512).optional(),
  webflow_api_key: z.string().min(1).max(512).optional(),
});

sitesRouter.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, url, cms, last_crawl_at, crawl_pages FROM sites WHERE user_id = ? ORDER BY id'
  )
    .bind(c.get('userId'))
    .all<{
      id: string;
      url: string;
      cms: string;
      last_crawl_at: number | null;
      crawl_pages: number | null;
    }>();
  return c.json({
    sites: rows.results.map((r) => ({
      id: r.id,
      url: r.url,
      cms: r.cms,
      lastCrawlAt: r.last_crawl_at,
      crawlPages: r.crawl_pages,
    })),
  });
});

sitesRouter.post('/', async (c) => {
  const parsed = ConnectBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  const body = parsed.data;

  // Site cap = count of non-refunded codes. 1 code = 1 site. No tiers.
  const userId = c.get('userId');
  const codeRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM licenses WHERE user_id = ? AND refunded_at IS NULL'
  )
    .bind(userId)
    .first<{ n: number }>();
  const codeCount = codeRow?.n ?? 0;
  if (codeCount === 0) return c.json({ error: 'no_active_license' }, 403);
  const siteCap = codeCount * SITE_CAP_PER_CODE;

  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sites WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= siteCap) {
    return c.json({ error: 'site_cap_reached', codes: codeCount, siteCap, used: countRow?.n }, 403);
  }

  // CMS-specific validation
  if (body.cms === 'wordpress' && (!body.wp_username || !body.wp_app_password)) {
    return c.json({ error: 'wp_credentials_required' }, 400);
  }
  if (body.cms === 'webflow' && !body.webflow_api_key) {
    return c.json({ error: 'webflow_key_required' }, 400);
  }

  // Encrypt credentials at rest
  let wpAppPwdBlob: Uint8Array | null = null;
  let webflowKeyBlob: Uint8Array | null = null;
  if (body.wp_app_password) wpAppPwdBlob = await encrypt(body.wp_app_password, c.env.RECTO_KEK);
  if (body.webflow_api_key) webflowKeyBlob = await encrypt(body.webflow_api_key, c.env.RECTO_KEK);

  const siteId = ulid();
  try {
    await c.env.DB.prepare(
      'INSERT INTO sites (id, user_id, url, cms, wp_username, wp_app_password, webflow_api_key, vector_namespace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        siteId,
        userId,
        body.url,
        body.cms,
        body.wp_username ?? null,
        wpAppPwdBlob,
        webflowKeyBlob,
        `site-${siteId}`
      )
      .run();
  } catch (e) {
    const msg = (e as Error).message || '';
    // D1 surfaces SQLite constraints as "UNIQUE constraint failed: sites.user_id, sites.url".
    // Match on either the column-name form or the index name.
    if (/UNIQUE constraint/i.test(msg) && /(sites\.user_id.*sites\.url|sites_user_url)/i.test(msg)) {
      const existing = await c.env.DB.prepare(
        'SELECT id, url, cms FROM sites WHERE user_id = ? AND url = ?'
      )
        .bind(userId, body.url)
        .first<{ id: string; url: string; cms: string }>();
      return c.json({ error: 'already_connected', site: existing }, 409);
    }
    throw e;
  }

  return c.json({ id: siteId, url: body.url, cms: body.cms }, 201);
});

sitesRouter.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.param('id');
  // Confirm ownership before deletion. Atomic via WHERE.
  const result = await c.env.DB.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .run();
  // D1Response.meta.changes tells us if a row was hit; if zero, the site either does not exist
  // or belongs to another user — same response either way to avoid existence-leak.
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /api/sites/:id/recrawl — start a crawl, return crawlId for SSE.
sitesRouter.post('/:id/recrawl', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.param('id');

  const site = await c.env.DB.prepare('SELECT id, url FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string; url: string }>();
  if (!site) return c.json({ error: 'not_found' }, 404);

  const crawlId = ulid();
  try {
    const { source, urls } = await discoverSitemap(site.url);

    // Seed the CrawlSession DO.
    const doId = c.env.CRAWL_SESSION.idFromName(crawlId);
    const stub = c.env.CRAWL_SESSION.get(doId);
    await stub.fetch('https://do/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawlId, siteId, seedUrls: urls }),
    });

    // Kick off the first tick.
    await c.env.Q_CRAWL.send({ siteId, trigger: 'manual', crawlId });

    return c.json({ crawlId, source, seeded: urls.length }, 202);
  } catch (e) {
    // Three classes of transient failure show up here:
    //   - Queue producer rate-limited (heavy concurrent recrawls)
    //   - DO over-loaded (very rare; per-name DO so traffic shouldn't pile)
    //   - External fetch failing during sitemap discovery
    // None are fatal; the SPA shows "retry in a moment".
    console.warn('recrawl transient failure', { siteId, error: (e as Error).message });
    return c.json({ error: 'recrawl_unavailable', retry_after_seconds: 30 }, 503);
  }
});

// GET /api/sites/:id/crawl/:crawlId/events — SSE proxy to the DO.
sitesRouter.get('/:id/crawl/:crawlId/events', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.param('id');
  const crawlId = c.req.param('crawlId');

  const own = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!own) return c.json({ error: 'not_found' }, 404);

  const doId = c.env.CRAWL_SESSION.idFromName(crawlId);
  const stub = c.env.CRAWL_SESSION.get(doId);
  return stub.fetch('https://do/sse');
});

// GET /api/sites/:id/crawl/:crawlId/state — single-shot progress poll.
sitesRouter.get('/:id/crawl/:crawlId/state', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.param('id');
  const crawlId = c.req.param('crawlId');

  const own = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!own) return c.json({ error: 'not_found' }, 404);

  const doId = c.env.CRAWL_SESSION.idFromName(crawlId);
  const stub = c.env.CRAWL_SESSION.get(doId);
  return stub.fetch('https://do/state');
});
