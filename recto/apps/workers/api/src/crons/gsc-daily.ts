// gsc-daily-incremental — pulls yesterday's Search Analytics rows for every
// site that has GSC connected. Enqueues one `day` job per site to spread load
// across the q-gsc-backfill consumer.

import type { Env } from '../env';
import { nDaysAgo } from '../lib/gsc-token';

export async function gscDailyIncremental(env: Env): Promise<void> {
  const day = nDaysAgo(1); // yesterday in UTC
  const sites = await env.DB.prepare(
    'SELECT id FROM sites WHERE gsc_refresh_token IS NOT NULL AND gsc_property IS NOT NULL'
  ).all<{ id: string }>();

  // Enqueue in sendBatch chunks of 100 rather than one await per site, so even
  // thousands of GSC-connected sites fan out well within the cron budget — and
  // no site is ever capped/stranded. (Hardened 2026-06-06.)
  const rows = sites.results ?? [];
  const messages = rows.map((s) => ({ body: { siteId: s.id, kind: 'day' as const, day } }));
  for (let i = 0; i < messages.length; i += 100) {
    await env.Q_GSC_BACKFILL.sendBatch(messages.slice(i, i + 100));
  }
  console.log('gsc-daily-incremental', { sites: rows.length, day });
}
