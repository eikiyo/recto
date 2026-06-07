// Daily reverify sweep. Two jobs:
//   1. Re-check verified pushes whose last verification was >24h ago — catches
//      a theme update or page edit that silently stripped the inserted anchor.
//   2. Re-confirm pushes stuck in 'pushed' (written to the CMS but never
//      verified) older than PUSHED_STALE_MS — these are pushes whose live-page
//      verification couldn't REACH the host (transient) and so were left
//      'pushed' rather than wrongly marked 'failed'. The sweep retries them
//      until the host is reachable. (Without this they'd never be re-verified,
//      since the queue's own retries are exhausted.) (Hardened 2026-06-07.)
//
// Failed pushes stay failed until the user manually retries.

import type { Env } from '../env';

const REVERIFY_AGE_MS = 24 * 60 * 60 * 1000;
const PUSHED_STALE_MS = 30 * 60 * 1000; // a 'pushed' older than this is overdue for confirmation
const BATCH = 200;

export async function reverifySweep(env: Env): Promise<void> {
  const cutoff = Date.now() - REVERIFY_AGE_MS;
  const pushedCutoff = Date.now() - PUSHED_STALE_MS;
  const rows = await env.DB.prepare(
    `SELECT id FROM pushes
      WHERE (status = 'verified' AND (verified_at IS NULL OR verified_at < ?))
         OR (status = 'pushed'   AND pushed_at < ?)
      ORDER BY verified_at ASC NULLS FIRST
      LIMIT ?`
  )
    .bind(cutoff, pushedCutoff, BATCH)
    .all<{ id: string }>();

  for (const r of rows.results ?? []) {
    await env.Q_VERIFY.send({ pushId: r.id, attempt: 1 });
  }
}
