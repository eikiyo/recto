// Monthly anchor-credit reset. Runs at 00:00 UTC on the 1st of every month.
//
// Pricing model: 1 code = 1 site + 100 anchor credits/month. Credits do NOT
// carry month-to-month. On the 1st, every user is overwritten to
// `non_refunded_code_count * ANCHOR_CREDITS_PER_CODE_MONTHLY` — regardless of
// whether they had 0 left or 500 unused.
//
// One SQL statement: a JOIN-update against the licenses count subquery. D1
// handles ~100k row updates in a single round-trip well within the cron
// execution budget; if we ever cross 1M users this becomes paginated.

import type { Env } from '../env';
import { ANCHOR_CREDITS_PER_CODE_MONTHLY } from '@recto/shared';

export async function monthlyAnchorReset(env: Env): Promise<void> {
  const started = Date.now();

  // Overwrite every user's anchor_credits to count(active codes) * 100.
  // Users with no codes get 0 (refunded everyone — no allowance).
  const result = await env.DB.prepare(
    `UPDATE users
        SET anchor_credits = (
          SELECT COALESCE(COUNT(*), 0) * ?
            FROM licenses
           WHERE licenses.user_id = users.id
             AND licenses.refunded_at IS NULL
        )`
  )
    .bind(ANCHOR_CREDITS_PER_CODE_MONTHLY)
    .run();

  console.log('monthly-reset complete', {
    rowsAffected: result.meta?.changes ?? 0,
    durationMs: Date.now() - started,
  });
}
