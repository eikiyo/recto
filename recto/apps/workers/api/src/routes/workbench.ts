import { Hono } from 'hono';
import type { Env } from '../env';
import { requireSession, type AuthVars } from '../auth/middleware';

export const workbenchRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
workbenchRouter.use('*', requireSession);

// GET /api/workbench/since — the three numerals on the workbench top block.
// All counts are scoped to the authenticated user's sites and to whatever the
// "since" cutoff is. v1 cutoff = the second-most-recent login (since the current
// login becomes the new "last_login_at"); we approximate using the cookie's
// session created_at when available, falling back to 7d ago.

workbenchRouter.get('/since', async (c) => {
  const userId = c.get('userId');

  // The user's previous-but-one session start. The current session was just minted
  // by /auth/callback, so we look for the most recent OTHER session.
  const prev = await c.env.DB.prepare(
    `SELECT expires_at FROM sessions
       WHERE user_id = ? AND id != ?
       ORDER BY expires_at DESC LIMIT 1`
  )
    .bind(userId, c.get('sessionId'))
    .first<{ expires_at: number }>();

  // expires_at = created + 30d, so subtract.
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const since = prev ? prev.expires_at - SESSION_TTL_MS : Date.now() - 7 * 24 * 60 * 60 * 1000;

  // The three counts are independent reads — fire them concurrently rather than
  // serially awaiting each. On D1 each .first() is its own round-trip; serial
  // made /since a 3×-RTT page-load blocker on the workbench top block. Promise.all
  // collapses it to one RTT-bound wait. (Hardened 2026-06-07 — lightning response.)
  const [newPages, newOrphans, newCandidates] = await Promise.all([
    // New pages: pages.crawled_at >= since across the user's sites.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM pages p JOIN sites s ON s.id = p.site_id
        WHERE s.user_id = ? AND p.crawled_at >= ?`
    )
      .bind(userId, since)
      .first<{ n: number }>(),

    // New orphans: pages crawled since `since` that have zero rows in edges where dst_page_id = page.id.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM pages p
         JOIN sites s ON s.id = p.site_id
        WHERE s.user_id = ? AND p.crawled_at >= ?
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)`
    )
      .bind(userId, since)
      .first<{ n: number }>(),

    // New anchor candidates generated since `since`.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM candidates c
         JOIN pages p ON p.id = c.orphan_page_id
         JOIN sites s ON s.id = p.site_id
        WHERE s.user_id = ? AND c.generated_at >= ?`
    )
      .bind(userId, since)
      .first<{ n: number }>(),
  ]);

  return c.json({
    since,
    pages: newPages?.n ?? 0,
    orphans: newOrphans?.n ?? 0,
    candidates: newCandidates?.n ?? 0,
  });
});

// GET /api/workbench/sites — multi-site summary for the dashboard top row.
// One row per site: name, crawl freshness, open orphan count, last push status.
workbenchRouter.get('/sites', async (c) => {
  const userId = c.get('userId');
  const rows = await c.env.DB.prepare(
    `SELECT
       s.id, s.url, s.cms, s.last_crawl_at, s.crawl_pages,
       (SELECT COUNT(*) FROM pages p
          WHERE p.site_id = s.id
            AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)
       ) AS open_orphans,
       (SELECT COUNT(*) FROM pushes pu
          JOIN candidates c ON c.id = pu.candidate_id
          JOIN pages sp ON sp.id = c.source_page_id
         WHERE sp.site_id = s.id AND pu.status = 'verified'
       ) AS verified_pushes,
       (SELECT MAX(pu.pushed_at) FROM pushes pu
          JOIN candidates c ON c.id = pu.candidate_id
          JOIN pages sp ON sp.id = c.source_page_id
         WHERE sp.site_id = s.id
       ) AS last_push_at
     FROM sites s
     WHERE s.user_id = ?
     ORDER BY s.last_crawl_at DESC NULLS LAST, s.id`
  )
    .bind(userId)
    .all();
  return c.json({ sites: rows.results ?? [] });
});

// GET /api/workbench/publishing-gap?siteId=...
// Only renders when at least 5 orphans share a slug cluster (first 2 path
// segments). The contract: if no cluster has ≥5, return { gaps: [] }. The
// UI then suppresses the section entirely — no empty state.
workbenchRouter.get('/publishing-gap', async (c) => {
  const userId = c.get('userId');
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'siteId_required' }, 400);

  const ownership = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!ownership) return c.json({ error: 'not_found' }, 404);

  // Cluster orphans by first two path segments.
  const rows = await c.env.DB.prepare(
    `SELECT p.slug, p.title
       FROM pages p
      WHERE p.site_id = ?
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)`
  )
    .bind(siteId)
    .all<{ slug: string; title: string | null }>();

  const buckets = new Map<string, { count: number; samples: string[] }>();
  for (const r of rows.results ?? []) {
    const key = clusterKey(r.slug);
    const b = buckets.get(key) ?? { count: 0, samples: [] };
    b.count += 1;
    if (b.samples.length < 3 && r.title) b.samples.push(r.title);
    buckets.set(key, b);
  }

  const gaps = [...buckets.entries()]
    .filter(([, b]) => b.count >= 5)
    .map(([cluster, b]) => ({ cluster, orphanCount: b.count, samples: b.samples }))
    .sort((a, b) => b.orphanCount - a.orphanCount);

  return c.json({ gaps });
});

function clusterKey(slug: string): string {
  const parts = slug.split('/').filter(Boolean).slice(0, 2);
  return '/' + parts.join('/');
}
