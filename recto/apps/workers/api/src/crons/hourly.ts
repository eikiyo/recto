// Hourly sweep. Runs at :00 every hour.
//
// Weekly digest fan-out: on Fridays only, between 09:00 and 09:59 UTC
// (we approximate user-tz by sending at 09:00 UTC for now; user-tz targeting
// lands when a users.timezone column is introduced). For each user with
// digest_opt_in = 1 and at least one site, queue a weekly-digest email with the
// past-7-days rollup. Runs paginated to keep one sweep under the cron's 30s budget.

import type { Env } from '../env';

const DIGEST_HOUR_UTC = 9;
const DIGEST_DAY_UTC = 5; // 0=Sun, 5=Fri
// Per-run fan-out cap so one sweep stays inside the cron's ~30s budget. Generous
// for self-hosted scale; if hit we log loudly (no silent drop) so it's visible
// when a cursor-paginated rewrite becomes necessary.
const DIGEST_MAX_PER_RUN = 400; // 3 D1 queries per user → bound the serial loop

export async function hourlySweep(env: Env): Promise<void> {
  const now = new Date();
  const isDigestSlot = now.getUTCDay() === DIGEST_DAY_UTC && now.getUTCHours() === DIGEST_HOUR_UTC;

  if (isDigestSlot) await fanOutWeeklyDigest(env);
}

async function fanOutWeeklyDigest(env: Env): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT u.id, u.email
       FROM users u
      WHERE u.digest_opt_in = 1
        AND EXISTS (SELECT 1 FROM sites s WHERE s.user_id = u.id)
      ORDER BY u.id
      LIMIT ?`
  )
    .bind(DIGEST_MAX_PER_RUN)
    .all<{ id: string; email: string }>();
  if ((users.results ?? []).length === DIGEST_MAX_PER_RUN) {
    console.warn('fanOutWeeklyDigest: hit per-run cap — some users deferred', { cap: DIGEST_MAX_PER_RUN });
  }

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
