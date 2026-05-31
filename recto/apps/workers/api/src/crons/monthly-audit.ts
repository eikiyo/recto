// Monthly anchor-credit audit. Runs at 01:00 UTC on the 1st of every month,
// exactly one hour after the main reset cron. Self-healing safety net.
//
// What it does:
//   1. Recomputes every user's expected ceiling: count(active codes) × 100.
//   2. Detects mismatches:
//      - DRIFT_UP   → user has more credits than they should (impossible
//                     under normal flow but catches a stuck-data anomaly).
//      - DRIFT_DOWN → user has fewer credits than the new ceiling
//                     (the reset cron failed or partially failed for them).
//   3. Heals: sets every mismatched user to the expected value.
//   4. Logs aggregate counts for observability — operator can search:
//        wrangler tail recto-api | grep monthly-audit
//
// Why a separate cron and not a retry on the first cron?
//   - Cloudflare cron triggers don't retry on partial failure of a SQL
//     UPDATE that touched some rows but not all. A second pass is the only
//     reliable recovery.
//   - 60 min buffer lets the main reset complete even under unusual D1
//     latency. We've never seen >5 min in prod but the budget is cheap.
//   - If the main cron didn't fire at all, this one runs alone and acts
//     as the single source of truth — same UPDATE, same outcome.

import type { Env } from '../env';
import { ANCHOR_CREDITS_PER_CODE_MONTHLY } from '@recto/shared';

export async function monthlyAnchorAudit(env: Env): Promise<void> {
  const started = Date.now();

  // Find users whose anchor_credits ≠ count(active codes) × 100.
  const drift = await env.DB.prepare(
    `SELECT u.id AS user_id,
            u.anchor_credits AS actual,
            COALESCE((
              SELECT COUNT(*)
                FROM licenses
               WHERE licenses.user_id = u.id
                 AND licenses.refunded_at IS NULL
            ), 0) * ? AS expected
       FROM users u`
  )
    .bind(ANCHOR_CREDITS_PER_CODE_MONTHLY)
    .all<{ user_id: string; actual: number; expected: number }>();

  const rows = drift.results ?? [];
  const mismatches = rows.filter((r) => r.actual !== r.expected);

  if (mismatches.length === 0) {
    console.log('monthly-audit clean', {
      checked: rows.length,
      durationMs: Date.now() - started,
    });
    return;
  }

  // Heal. Batch the UPDATEs into a single transaction-equivalent SQL pass
  // via prepared statements. D1 supports `batch()` for atomic multi-statement
  // execution.
  const stmts = mismatches.map((m) =>
    env.DB.prepare('UPDATE users SET anchor_credits = ? WHERE id = ?').bind(
      m.expected,
      m.user_id
    )
  );
  await env.DB.batch(stmts);

  const driftUp = mismatches.filter((m) => m.actual > m.expected).length;
  const driftDown = mismatches.filter((m) => m.actual < m.expected).length;

  console.log('monthly-audit healed', {
    checked: rows.length,
    healed: mismatches.length,
    driftUp,
    driftDown,
    durationMs: Date.now() - started,
  });
}
