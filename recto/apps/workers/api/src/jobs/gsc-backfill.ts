// q-gsc-backfill consumer.
// Two job kinds:
//   - { kind: 'backfill', siteId, daysBack }: fan out one `day` job per day.
//   - { kind: 'day', siteId, day }: fetch Search Analytics rows for that day,
//     upsert into gsc_data, joining on pages.slug to find page_id.

import type { Env, GscBackfillJob } from '../env';
import { searchAnalyticsPage, isDomainProperty } from '../integrations/gsc';
import { accessTokenForSite, nDaysAgo } from '../lib/gsc-token';
import { retryOrDrop } from '../lib/queue';
import { normalizeUrl, pathOf } from '../lib/url-norm';

const MAX_QUOTA_DELIVERIES = 4;   // quota: a few spaced retries, then defer to the daily cron
const MAX_BACKFILL_DELIVERIES = 5; // unknown errors: bound then drop (cron re-fills later)

export async function handleGscBackfillBatch(
  batch: MessageBatch<GscBackfillJob>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      if (job.kind === 'backfill') {
        // Fan out: one job per day, oldest first so user sees data accumulating
        // in the expected order.
        for (let i = job.daysBack - 1; i >= 1; i--) {
          await env.Q_GSC_BACKFILL.send({ siteId: job.siteId, kind: 'day', day: nDaysAgo(i) });
        }
        msg.ack();
      } else {
        await fetchAndStoreDay(env, job.siteId, job.day);
        msg.ack();
      }
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'gsc_quota') {
        // Quota — retry a few times spaced out, then drop (the daily incremental
        // cron re-fetches the day anyway). Bounded so a stuck quota can't loop.
        retryOrDrop(msg, 'gsc-backfill/quota', { siteId: job.siteId, kind: job.kind, day: (job as { day?: string }).day }, MAX_QUOTA_DELIVERIES, 60 * 5);
      } else if (m === 'gsc_not_connected' || m === 'gsc_reauth_required') {
        // No point retrying; user must reconnect.
        msg.ack();
      } else {
        // Unknown/transient error — bounded retry, then drop with a loud log
        // instead of looping to the silent ~100-delivery platform default.
        retryOrDrop(msg, 'gsc-backfill', { siteId: job.siteId, kind: job.kind, error: m }, MAX_BACKFILL_DELIVERIES, 30);
      }
    }
  }
}

async function fetchAndStoreDay(env: Env, siteId: string, day: string): Promise<void> {
  const tok = await accessTokenForSite(env, siteId);
  if ('error' in tok) throw new Error(tok.error);

  const rows = await searchAnalyticsPage({
    accessToken: tok.accessToken,
    siteUrl: tok.property,
    day,
    rowLimit: 5000,
  });

  // Join GSC page URLs to recto's pages table by slug match.
  // For domain properties (sc-domain:), Google returns absolute URLs; we
  // store pages.slug as the path. For URL properties we strip the origin.
  const stmts: D1PreparedStatement[] = [];
  for (const row of rows) {
    const fullUrl = row.keys?.[0];
    if (!fullUrl) continue;
    const slug = toSlug(fullUrl);
    const page = await env.DB.prepare(
      'SELECT id FROM pages WHERE site_id = ? AND slug = ?'
    )
      .bind(siteId, slug)
      .first<{ id: string }>();
    if (!page) continue;

    stmts.push(
      env.DB.prepare(
        `INSERT INTO gsc_data (page_id, day, impressions, clicks, position)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(page_id, day) DO UPDATE SET
             impressions = excluded.impressions,
             clicks = excluded.clicks,
             position = excluded.position`
      ).bind(page.id, day, row.impressions, row.clicks, row.position)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  void isDomainProperty; // keep import live for future per-property logic
}

// Produce the slug EXACTLY as the crawler stores it in pages.slug, so the
// gsc_data→pages join matches. pages.slug = pathOf(normalizeUrl(crawledUrl));
// crawl seeds + discovered links all pass through normalizeUrl, which strips a
// trailing slash (except root) and lowercases the host. Google reports WordPress
// permalinks WITH the trailing slash (`/my-post/`), but pages.slug is stored
// WITHOUT it (`/my-post`) — so the old `u.pathname` join silently missed every
// trailing-slash page and the orphan ranking lost its primary signal (28-day
// impressions). Deriving the slug through the SAME two functions keeps the two
// sides from ever drifting again. (Hardened 2026-06-07.)
export function toSlug(absoluteUrl: string): string {
  const norm = normalizeUrl(absoluteUrl);
  if (norm) return pathOf(norm);
  try {
    return new URL(absoluteUrl).pathname || '/';
  } catch {
    return absoluteUrl;
  }
}
