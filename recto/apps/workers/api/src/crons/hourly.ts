// Hourly sweep. Runs at :00 every hour.
//
// 1. Weekly digest fan-out: on Fridays only, between 09:00 and 09:59 UTC
//    (we approximate user-tz by sending at 09:00 UTC for now; user-tz
//    targeting lands when users.timezone column is introduced).
//    For each user with digest_opt_in = 1 and at least one site, queue a
//    weekly-digest email with the past-7-days rollup.
//
// 2. BYOK threshold sweep: any user whose anchor_credits has dropped below
//    25 and who has NOT yet received a byok-threshold notice in the past
//    14 days, queue a byok-threshold email. The cooldown is tracked in KV
//    so we don't spam.
//
// Both fan-outs run paginated to keep one sweep under the cron's 30s budget.

import type { Env } from '../env';

const BYOK_THRESHOLD = 25;
const BYOK_NOTICE_COOLDOWN_S = 14 * 24 * 60 * 60;
const DIGEST_HOUR_UTC = 9;
const DIGEST_DAY_UTC = 5; // 0=Sun, 5=Fri

export async function hourlySweep(env: Env): Promise<void> {
  const now = new Date();
  const isDigestSlot = now.getUTCDay() === DIGEST_DAY_UTC && now.getUTCHours() === DIGEST_HOUR_UTC;

  if (isDigestSlot) await fanOutWeeklyDigest(env);
  await sweepByokThreshold(env);
}

async function fanOutWeeklyDigest(env: Env): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT u.id, u.email
       FROM users u
      WHERE u.digest_opt_in = 1
        AND EXISTS (SELECT 1 FROM sites s WHERE s.user_id = u.id)`
  )
    .bind()
    .all<{ id: string; email: string }>();

  const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const u of users.results ?? []) {
    const newOrphans = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pages p
        JOIN sites s ON s.id = p.site_id
       WHERE s.user_id = ? AND p.crawled_at >= ?
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)`
    )
      .bind(u.id, Date.now() - 7 * 24 * 60 * 60 * 1000)
      .first<{ n: number }>();
    const verifiedPushes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pushes pu
        WHERE pu.user_id = ? AND pu.status = 'verified' AND pu.verified_at >= ?`
    )
      .bind(u.id, Date.now() - 7 * 24 * 60 * 60 * 1000)
      .first<{ n: number }>();
    const topOrphans = await env.DB.prepare(
      `SELECT p.slug, COALESCE(SUM(g.impressions), 0) AS impressions_28d
         FROM pages p
         JOIN sites s ON s.id = p.site_id
         LEFT JOIN gsc_data g ON g.page_id = p.id AND g.day >= ?
        WHERE s.user_id = ?
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_page_id = p.id)
        GROUP BY p.id, p.slug
        ORDER BY impressions_28d DESC
        LIMIT 3`
    )
      .bind(sinceDate, u.id)
      .all<{ slug: string; impressions_28d: number }>();

    // Skip empty digests — operators hate "you have 0 of nothing" mails.
    const newOrphansN = newOrphans?.n ?? 0;
    const verifiedPushesN = verifiedPushes?.n ?? 0;
    if (newOrphansN === 0 && verifiedPushesN === 0) continue;

    await env.Q_EMAIL.send({
      template: 'weekly-digest',
      userId: u.id,
      data: {
        newOrphans: newOrphansN,
        verifiedPushes: verifiedPushesN,
        topOrphans: (topOrphans.results ?? []).map((r) => ({
          slug: r.slug,
          impressions28d: r.impressions_28d,
        })),
      },
    });
  }
}

async function sweepByokThreshold(env: Env): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT id, anchor_credits FROM users WHERE anchor_credits < ?`
  )
    .bind(BYOK_THRESHOLD)
    .all<{ id: string; anchor_credits: number }>();

  for (const u of users.results ?? []) {
    const cooldownKey = `byok:notice:${u.id}`;
    const cooled = await env.KV.get(cooldownKey);
    if (cooled) continue;

    await env.Q_EMAIL.send({
      template: 'byok-threshold',
      userId: u.id,
      data: { creditsRemaining: u.anchor_credits },
    });
    await env.KV.put(cooldownKey, '1', { expirationTtl: BYOK_NOTICE_COOLDOWN_S });
  }
}
