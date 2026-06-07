// q-verify consumer. Pulls the live page and confirms the link actually
// rendered. Some WordPress hosts strip data attributes or rewrite anchors via
// page builders, so the verifier checks for either the data-recto-link marker
// or a plain href match.
//
// On verified: pushes.status='verified', verified_at, verified_via.
// On miss (up to 3 attempts, exponential backoff): pushes.status='failed',
// failure_code='wp_post_failed', failure_msg='not visible after push'.

import type { Env } from '../env';
import { fetchWithTimeout, readTextCapped } from '../lib/http';
import { retryOrDrop } from '../lib/queue';

type VerifyMsg = { pushId: string; attempt: number };

const MAX_ATTEMPTS = 3;
// Hard delivery ceiling for the UNEXPECTED-exception path. The handled retries
// re-enqueue a fresh message and self-bound at MAX_ATTEMPTS; this only governs a
// message whose verifyOne THROWS every time (e.g. a malformed stored site_url so
// `new URL(orphan_slug, site_url)` raises, or a persistent D1 error). A bare
// msg.retry() there loops to the ~100-delivery platform default and then SILENTLY
// drops — the poison-message failure retryOrDrop bounds (every other consumer
// already uses it; q-verify had been missed). (Hardened 2026-06-07.)
const MAX_VERIFY_DELIVERIES = 5;
const VERIFY_TIMEOUT_MS = 30_000;     // a slow live page can't freeze the verify worker
const VERIFY_MAX_BYTES = 8_000_000;   // 8 MB cap reading the rendered page

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
      retryOrDrop(msg, 'verify', { pushId: msg.body.pushId, error: (e as Error).message }, MAX_VERIFY_DELIVERIES, 30);
    }
  }
}

async function verifyOne(env: Env, job: VerifyMsg): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT pu.id, pu.status, c.anchor_text, op.slug AS orphan_slug, sp.slug AS source_slug, s.url AS site_url
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
      status: string;
      anchor_text: string;
      orphan_slug: string;
      source_slug: string;
      site_url: string;
    }>();
  if (!row) return false;
  // Skip only terminal-NEGATIVE states. We must NOT skip 'verified': the daily
  // reverifySweep deliberately re-runs the verifier on verified pushes to catch
  // a theme/edit that silently stripped the anchor. A redelivered verify of a
  // verified push just re-confirms idempotently (cheap, no false state).
  // (Hardened 2026-06-06; corrected to preserve reverifySweep.)
  if (row.status === 'failed' || row.status === 'undone') return false;

  const liveUrl = new URL(row.source_slug, row.site_url).toString();
  const expectedHref = new URL(row.orphan_slug, row.site_url).toString();

  let res: Response;
  try {
    res = await fetchWithTimeout(liveUrl, {
      headers: { 'User-Agent': 'recto-verify/1.0 (+https://recto.so)' },
      cf: { cacheTtl: 0 } as RequestInitCfProperties,
    }, VERIFY_TIMEOUT_MS);
  } catch (e) {
    return await maybeRetry(env, job, 'network', (e as Error).message);
  }
  if (!res.ok) {
    return await maybeRetry(env, job, 'http', `status ${res.status}`);
  }
  let html: string;
  try {
    html = await readTextCapped(res, VERIFY_MAX_BYTES);
  } catch (e) {
    return await maybeRetry(env, job, 'network', (e as Error).message);
  }

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

  // Attempts exhausted. The cause matters:
  //   - 'invisible': we REACHED the page and the link is not in the HTML → the
  //     push genuinely didn't take. Mark failed so the user sees it + can retry.
  //   - 'network'/'http': we could not REACH the page. The push itself already
  //     succeeded (status is 'pushed'); flipping it to 'failed' would lie to the
  //     user ("push failed" when the link is live) and could trigger a needless
  //     re-push. Leave it 'pushed' — the daily reverify sweep re-confirms it
  //     once the host is reachable again. (Hardened 2026-06-07.)
  if (cause === 'invisible') {
    await env.DB.prepare(
      `UPDATE pushes
          SET status = 'failed',
              failure_code = ?,
              failure_msg = ?
        WHERE id = ?`
    )
      .bind('wp_post_failed', `verify_invisible: ${detail}`, job.pushId)
      .run();
  } else {
    console.warn('verify: host unreachable after max attempts — leaving status=pushed for the daily reverify sweep', {
      pushId: job.pushId,
      cause,
      detail,
    });
  }
  return false;
}
