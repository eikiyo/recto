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

  for (const s of sites.results) {
    await env.Q_GSC_BACKFILL.send({ siteId: s.id, kind: 'day', day });
  }
  console.log('gsc-daily-incremental', { sites: sites.results.length, day });
}
