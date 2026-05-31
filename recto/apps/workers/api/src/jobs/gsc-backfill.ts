// q-gsc-backfill consumer.
// Two job kinds:
//   - { kind: 'backfill', siteId, daysBack }: fan out one `day` job per day.
//   - { kind: 'day', siteId, day }: fetch Search Analytics rows for that day,
//     upsert into gsc_data, joining on pages.slug to find page_id.

import type { Env, GscBackfillJob } from '../env';
import { searchAnalyticsPage, isDomainProperty } from '../integrations/gsc';
import { accessTokenForSite, nDaysAgo } from '../lib/gsc-token';

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
        // Quota — retry once with delay; further failure → DLQ when configured.
        msg.retry({ delaySeconds: 60 * 5 });
      } else if (m === 'gsc_not_connected' || m === 'gsc_reauth_required') {
        // No point retrying; user must reconnect.
        msg.ack();
      } else {
        console.error('gsc-backfill error', { siteId: job.siteId, kind: job.kind, error: m });
        msg.retry({ delaySeconds: 30 });
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

function toSlug(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    return u.pathname || '/';
  } catch {
    return absoluteUrl;
  }
}
