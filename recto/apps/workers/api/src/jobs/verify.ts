// q-verify consumer. Pulls the live page and confirms the link actually
// rendered. Some WordPress hosts strip data attributes or rewrite anchors via
// page builders, so the verifier checks for either the data-recto-link marker
// or a plain href match.
//
// On verified: pushes.status='verified', verified_at, verified_via.
// On miss (up to 3 attempts, exponential backoff): pushes.status='failed',
// failure_code='wp_post_failed', failure_msg='not visible after push'.

import type { Env } from '../env';

type VerifyMsg = { pushId: string; attempt: number };

const MAX_ATTEMPTS = 3;

export async function handleVerifyBatch(batch: MessageBatch<VerifyMsg>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const requeue = await verifyOne(env, msg.body);
      if (requeue) {
        msg.retry({ delaySeconds: 60 * Math.pow(2, msg.body.attempt) });
      } else {
        msg.ack();
      }
    } catch (e) {
      console.error('verify error', { pushId: msg.body.pushId, error: (e as Error).message });
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function verifyOne(env: Env, job: VerifyMsg): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT pu.id, c.anchor_text, op.slug AS orphan_slug, sp.slug AS source_slug, s.url AS site_url
       FROM pushes pu
       JOIN candidates c ON c.id = pu.candidate_id
       JOIN pages op     ON op.id = c.orphan_page_id
       JOIN pages sp     ON sp.id = c.source_page_id
       JOIN sites s      ON s.id = sp.site_id
      WHERE pu.id = ?`
  )
    .bind(job.pushId)
    .first<{
      id: string;
      anchor_text: string;
      orphan_slug: string;
      source_slug: string;
      site_url: string;
    }>();
  if (!row) return false;

  const liveUrl = new URL(row.source_slug, row.site_url).toString();
  const expectedHref = new URL(row.orphan_slug, row.site_url).toString();

  let res: Response;
  try {
    res = await fetch(liveUrl, {
      headers: { 'User-Agent': 'recto-verify/1.0 (+https://recto.so)' },
      cf: { cacheTtl: 0 } as RequestInitCfProperties,
    });
  } catch (e) {
    return await maybeRetry(env, job, 'network', (e as Error).message);
  }
  if (!res.ok) {
    return await maybeRetry(env, job, 'http', `status ${res.status}`);
  }
  const html = await res.text();

  const dataMarker = 'data-recto-link="1"';
  const hrefMatch = html.includes(`href="${expectedHref}"`);
  const dataMatch = html.includes(dataMarker);
  const anchorMatch = html.toLowerCase().includes(`>${row.anchor_text.toLowerCase()}<`);

  if (hrefMatch && (dataMatch || anchorMatch)) {
    await env.DB.prepare(
      `UPDATE pushes
          SET status = 'verified',
              verified_at = ?,
              verified_via = ?,
              failure_code = NULL,
              failure_msg = NULL
        WHERE id = ?`
    )
      .bind(Date.now(), dataMatch ? 'data-marker' : 'href-match', job.pushId)
      .run();
    return false;
  }

  return await maybeRetry(env, job, 'invisible', 'link not visible in rendered HTML');
}

async function maybeRetry(
  env: Env,
  job: VerifyMsg,
  cause: 'network' | 'http' | 'invisible',
  detail: string
): Promise<boolean> {
  if (job.attempt < MAX_ATTEMPTS) {
    // The queue retries with the same body; bump attempt so backoff grows.
    // (Cloudflare Queues doesn't let us mutate body on retry, so we requeue.)
    await env.Q_VERIFY.send(
      { pushId: job.pushId, attempt: job.attempt + 1 },
      { delaySeconds: 60 * Math.pow(2, job.attempt) }
    );
    return false; // ack the current — the bumped one carries forward
  }
  await env.DB.prepare(
    `UPDATE pushes
        SET status = 'failed',
            failure_code = ?,
            failure_msg = ?
      WHERE id = ?`
  )
    .bind('wp_post_failed', `verify_${cause}: ${detail}`, job.pushId)
    .run();
  return false;
}
