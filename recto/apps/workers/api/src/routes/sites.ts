import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { ulid } from '../lib/ids';
import { encrypt } from '../lib/crypto';
import { requireSession, type AuthVars } from '../auth/middleware';
import { discoverSitemap } from '../lib/sitemap';
import { withCors } from '../lib/cors';
import { verifyWpCredentials } from '../integrations/wordpress';

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
  // A colon in the username corrupts the Basic auth `user:pass` encoding (the
  // colon is the delimiter), producing a malformed header WordPress rejects.
  wp_username: z.string().min(1).max(256).refine((u) => !u.includes(':'), 'username cannot contain a colon').optional(),
  wp_app_password: z.string().min(1).max(512).optional(),
  webflow_api_key: z.string().min(1).max(512).optional(),
});

// Normalize a site URL so the SAME site can't be connected twice under cosmetic
// variants. The unique constraint is on the exact string, so without this
// "site.com", "site.com/", "https://www.site.com", and "HTTP://Site.com" were
// four distinct rows for one site. (Caught 2026-06-06.) Conservative: lowercase
// host, drop "www.", drop default ports, drop query/hash, strip trailing slash.
export function normalizeUrl(input: string): string {
  const u = new URL(input.trim());
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  u.search = '';
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  let out = u.toString();
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

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
  // Canonicalize the URL up front so dedup + storage both use one form.
  try { body.url = normalizeUrl(body.url); } catch { return c.json({ error: 'invalid_website' }, 400); }

  // Self-hosted: no site cap. Connect as many sites as you like.
  const userId = c.get('userId');

  // Explicit duplicate check on the normalized URL — return the existing site
  // (with its id, so the UI can route to "update credentials") instead of
  // creating a second row or wasting a live credential-verify call.
  const dup = await c.env.DB.prepare('SELECT id, url, cms FROM sites WHERE user_id = ? AND url = ?')
    .bind(userId, body.url)
    .first<{ id: string; url: string; cms: string }>();
  if (dup) return c.json({ error: 'already_connected', site: dup }, 409);

  // CMS-specific validation
  if (body.cms === 'wordpress' && (!body.wp_username || !body.wp_app_password)) {
    return c.json({ error: 'wp_credentials_required' }, 400);
  }
  if (body.cms === 'webflow' && !body.webflow_api_key) {
    return c.json({ error: 'webflow_key_required' }, 400);
  }

  // VERIFY WordPress credentials against the live REST API before storing. A
  // green connect must guarantee a push can authenticate — otherwise we store
  // bad creds silently and the failure only surfaces when the user approves a
  // link (wp_auth_failed at push time). This check is the whole reason connect
  // exists. (Root-caused 2026-06-06 from a real customer "connect isn't working"
  // report that was actually a silently-stored bad credential.)
  if (body.cms === 'wordpress' && body.wp_username && body.wp_app_password) {
    const verdict = await verifyWpCredentials({
      siteUrl: body.url,
      username: body.wp_username,
      appPassword: body.wp_app_password,
    });
    if (!verdict.ok) {
      return c.json({ error: verdict.code }, 422);
    }
  }

  // Encrypt credentials at rest
  let wpAppPwdBlob: Uint8Array | null = null;
  let webflowKeyBlob: Uint8Array | null = null;
  if (body.wp_app_password) wpAppPwdBlob = await encrypt(body.wp_app_password, c.env.RECTO_KEK);
  if (body.webflow_api_key) webflowKeyBlob = await encrypt(body.webflow_api_key, c.env.RECTO_KEK);

  const siteId = ulid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO sites (id, user_id, url, cms, wp_username, wp_app_password, webflow_api_key, vector_namespace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
    // Match on either the column-name form or the index name. (Race-safe: two
    // concurrent connects of the SAME url — the unique index makes the second fail
    // here, and we return the existing site instead of a duplicate row.)
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

  // Confirm ownership FIRST. The child deletes below are scoped by site_id
  // subqueries, so we must prove the site belongs to the caller before touching
  // anything. Same opaque 404 for "not found" and "not yours" (no existence leak).
  const own = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!own) return c.json({ error: 'not_found' }, 404);

  // Cascade by hand, FK-safe (child → parent), in ONE D1 batch (a transaction).
  // Every child table FK-references pages/candidates with NO ON DELETE CASCADE,
  // so a bare `DELETE FROM sites` violated the foreign key (500) on any crawled
  // site and otherwise stranded pages/candidates/pushes/edges/gsc_data/outlinks.
  // (This was the gap behind the manual child→parent deletes in the account flush,
  // 2026-06-06.) Every statement is scoped to this site via site_id subqueries.
  const pageIds = 'SELECT id FROM pages WHERE site_id = ?';
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM pushes WHERE candidate_id IN (
         SELECT id FROM candidates
          WHERE orphan_page_id IN (${pageIds}) OR source_page_id IN (${pageIds}))`
    ).bind(siteId, siteId),
    c.env.DB.prepare(
      `DELETE FROM candidates
        WHERE orphan_page_id IN (${pageIds}) OR source_page_id IN (${pageIds})`
    ).bind(siteId, siteId),
    c.env.DB.prepare(
      `DELETE FROM edges WHERE src_page_id IN (${pageIds}) OR dst_page_id IN (${pageIds})`
    ).bind(siteId, siteId),
    c.env.DB.prepare(`DELETE FROM gsc_data WHERE page_id IN (${pageIds})`).bind(siteId),
    c.env.DB.prepare(`DELETE FROM outlinks WHERE src_page_id IN (${pageIds})`).bind(siteId),
    c.env.DB.prepare('DELETE FROM pages WHERE site_id = ?').bind(siteId),
    c.env.DB.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?').bind(siteId, userId),
  ]);
  return c.json({ ok: true });
});

// PUT /api/sites/:id/credentials — update the CMS credentials on an existing
// site WITHOUT re-connecting/re-crawling. Verifies against the live CMS first
// (same gate as connect) so a green save guarantees pushes can authenticate.
// This existed nowhere before 2026-06-06 — a user who stored a bad app password
// had no way to fix it but delete + re-crawl, and the failure only surfaced at
// push time as wp_auth_failed.
sitesRouter.put('/:id/credentials', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.param('id');

  const site = await c.env.DB.prepare('SELECT id, url, cms FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string; url: string; cms: string }>();
  if (!site) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    wp_username?: string;
    wp_app_password?: string;
    webflow_api_key?: string;
  };

  if (site.cms === 'wordpress') {
    if (!body.wp_username || !body.wp_app_password) {
      return c.json({ error: 'wp_credentials_required' }, 400);
    }
    const verdict = await verifyWpCredentials({
      siteUrl: site.url,
      username: body.wp_username,
      appPassword: body.wp_app_password,
    });
    if (!verdict.ok) return c.json({ error: verdict.code }, 422);

    const blob = await encrypt(body.wp_app_password, c.env.RECTO_KEK);
    await c.env.DB.prepare('UPDATE sites SET wp_username = ?, wp_app_password = ? WHERE id = ? AND user_id = ?')
      .bind(body.wp_username, blob, siteId, userId)
      .run();
    return c.json({ ok: true });
  }

  if (site.cms === 'webflow') {
    if (!body.webflow_api_key) return c.json({ error: 'webflow_key_required' }, 400);
    const blob = await encrypt(body.webflow_api_key, c.env.RECTO_KEK);
    await c.env.DB.prepare('UPDATE sites SET webflow_api_key = ? WHERE id = ? AND user_id = ?')
      .bind(blob, siteId, userId)
      .run();
    return c.json({ ok: true });
  }

  return c.json({ error: 'wp_unknown' }, 400);
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
  // The DO returns the raw SSE stream — it bypasses the global CORS middleware
  // (which sets headers via c.header()), so re-apply credentialed CORS here or
  // the browser drops every cross-subdomain event silently.
  const res = await stub.fetch('https://do/sse');
  return withCors(res, c.req.header('origin'));
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
  // Return the DO response THROUGH withCors. Returning the raw stub.fetch()
  // Response bypasses the CORS middleware (which sets headers via c.header()),
  // so the browser blocked every /state poll cross-subdomain (rectoapp.com →
  // api.rectoapp.com) — the crawl progress page never got data and froze on
  // "Starting…". Same fix as the SSE route. (Caught via live UI 2026-06-06.)
  const res = await stub.fetch('https://do/state');
  return withCors(res, c.req.header('origin'));
});
