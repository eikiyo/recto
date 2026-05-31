// Daily reverify sweep. Pulls verified pushes whose last verification was
// more than 24h ago and re-runs the verifier. Catches the case where a
// theme update or page edit silently strips the inserted anchor.
//
// Only verified pushes (status='verified') are re-checked. Failed pushes
// stay failed until the user manually retries.

import type { Env } from '../env';

const REVERIFY_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export async function reverifySweep(env: Env): Promise<void> {
  const cutoff = Date.now() - REVERIFY_AGE_MS;
  const rows = await env.DB.prepare(
    `SELECT id FROM pushes
      WHERE status = 'verified'
        AND (verified_at IS NULL OR verified_at < ?)
      ORDER BY verified_at ASC NULLS FIRST
      LIMIT ?`
  )
    .bind(cutoff, BATCH)
    .all<{ id: string }>();

  for (const r of rows.results ?? []) {
    await env.Q_VERIFY.send({ pushId: r.id, attempt: 1 });
  }
}
