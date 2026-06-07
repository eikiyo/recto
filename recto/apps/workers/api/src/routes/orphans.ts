// GET /api/sites/:id/orphans — ranked orphan list.
//
// Score = log1p(impressions_28d) + recency_boost + baseline.
//   - baseline: every orphan starts at 1.0 (it is broken; it deserves a fix slot)
//   - GSC weight: log1p(impressions over last 28d). Pages that already rank
//     somewhere but have zero internal links are the biggest wins.
//   - recency_boost: +0.5 if last_modified or crawled_at within 30d. Operators
//     care about freshly-published orphans more than stale corners.
//
// Authorization: site must belong to the calling user.

import { Hono } from 'hono';
import type { Env } from '../env';
import { requireSession, type AuthVars } from '../auth/middleware';

export const orphansRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
orphansRouter.use('*', requireSession);

const DEFAULT_LIMIT = 50;
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GSC_WINDOW_DAYS = 28;

orphansRouter.get('/:id/orphans', async (c) => {
  const siteId = c.req.param('id');
  const userId = c.get('userId');

  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!site) return c.json({ error: 'not_found' }, 404);

  const rawLimit = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : DEFAULT_LIMIT;

  // Compute the GSC cutoff as YYYY-MM-DD (gsc_data.day is stored as ISO date).
  const cutoffDate = new Date(Date.now() - GSC_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const recencyCutoff = Date.now() - RECENCY_WINDOW_MS;

  const rows = await c.env.DB.prepare(
    `
    SELECT
      p.id            AS id,
      p.slug          AS slug,
      p.title         AS title,
      p.h1            AS h1,
      p.crawled_at    AS crawled_at,
      p.last_modified AS last_modified,
      COALESCE(g.impressions_28d, 0)  AS impressions_28d,
      COALESCE(g.clicks_28d, 0)       AS clicks_28d,
      g.avg_position                  AS avg_position
    FROM pages p
    LEFT JOIN (
      -- Scope the GSC aggregate to THIS site's pages. Without the
      -- pages JOIN + site_id filter, SQLite materializes sums over EVERY
      -- tenant's gsc_data for the day window on every orphans load, then
      -- joins — O(all rows) instead of O(this site). Output is identical
      -- (the outer query only keeps p.site_id = ? pages anyway); this merely
      -- stops aggregating other sites' data. (Perf 2026-06-07.)
      SELECT g.page_id,
             SUM(g.impressions) AS impressions_28d,
             SUM(g.clicks)      AS clicks_28d,
             AVG(g.position)    AS avg_position
        FROM gsc_data g
        JOIN pages gp ON gp.id = g.page_id
       WHERE gp.site_id = ?
         AND g.day >= ?
       GROUP BY g.page_id
    ) g ON g.page_id = p.id
    WHERE p.site_id = ?
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)
      -- Hide WordPress system pages so orphan ranking surfaces real content only.
      AND p.slug NOT IN ('/wp-admin','/wp-login.php','/sample-page','/hello-world','/wp-json','/feed','/comments/feed','/wp-sitemap.xml','/xmlrpc.php','/wp-cron.php')
      AND p.slug NOT LIKE '/wp-admin/%'
      AND p.slug NOT LIKE '/wp-content/%'
      AND p.slug NOT LIKE '/wp-includes/%'
      AND p.slug NOT LIKE '/wp-json/%'
      AND p.slug NOT LIKE '/feed/%'
      AND p.slug NOT LIKE '/author/%'
      AND p.slug NOT LIKE '/tag/%'
      AND p.slug NOT LIKE '/category/%'
      AND p.slug NOT LIKE '/page/%'
    ORDER BY
      COALESCE(g.impressions_28d, 0) DESC,
      p.crawled_at DESC
    LIMIT ?
  `
  )
    .bind(siteId, cutoffDate, siteId, limit)
    .all<{
      id: string;
      slug: string;
      title: string | null;
      h1: string | null;
      crawled_at: number;
      last_modified: number | null;
      impressions_28d: number;
      clicks_28d: number;
      avg_position: number | null;
    }>();

  const results = (rows.results ?? []).map((r) => {
    const baseline = 1.0;
    const gscWeight = Math.log1p(r.impressions_28d);
    const fresh = r.last_modified ?? r.crawled_at;
    const recencyBoost = fresh >= recencyCutoff ? 0.5 : 0;
    const score = +(baseline + gscWeight + recencyBoost).toFixed(3);

    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      h1: r.h1,
      score,
      breakdown: {
        baseline,
        gscWeight: +gscWeight.toFixed(3),
        recencyBoost,
      },
      gsc: {
        impressions28d: r.impressions_28d,
        clicks28d: r.clicks_28d,
        avgPosition: r.avg_position,
      },
      crawledAt: r.crawled_at,
      lastModified: r.last_modified,
    };
  });

  return c.json({
    siteId,
    window: { days: GSC_WINDOW_DAYS, since: cutoffDate },
    count: results.length,
    orphans: results,
  });
});
