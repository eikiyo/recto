// q-push consumer. One message = one user-approved candidate → one CMS write.
//
// Flow:
//   1. Load the push row + candidate + site credentials.
//   2. Call pushLink(env, input).
//   3. Update pushes.status + audit columns. Queue Q_VERIFY on success.
//
// On retry: failure_code drives behavior. Auth failures don't auto-retry —
// the user must re-enter the WP app password. Network/post_failed retry up
// to 3 times with backoff.

import type { Env } from '../env';
import { pushLink, type PushOutcome } from '../integrations/wordpress';
import { fetchWithTimeout } from '../lib/http';
import { retryOrDrop } from '../lib/queue';

type PushMsg = { pushId: string };

const MAX_RETRY = 3;
// Hard delivery ceiling for the UNEXPECTED-exception path. The handled retries
// (transient WP / retryable outcome) self-bound at MAX_RETRY via msg.attempts;
// this only governs a message whose runPush THROWS every time (e.g. a malformed
// stored site_url so `new URL()` raises, or a persistent D1 error). A bare
// msg.retry() there loops to the ~100-delivery platform default and then SILENTLY
// drops — the exact poison-message failure retryOrDrop exists to bound (every
// other consumer already uses it; q-push had been missed). (Hardened 2026-06-07.)
const MAX_PUSH_DELIVERIES = 5;
const WP_TIMEOUT_MS = 10_000; // slug→post-id resolution against an untrusted WP host

export async function handlePushBatch(batch: MessageBatch<PushMsg>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const requeue = await runPush(env, msg.body.pushId, msg.attempts ?? 1);
      if (requeue) {
        msg.retry({ delaySeconds: 60 * (msg.attempts ?? 1) });
      } else {
        msg.ack();
      }
    } catch (e) {
      retryOrDrop(msg, 'push', { pushId: msg.body.pushId, error: (e as Error).message }, MAX_PUSH_DELIVERIES, 30);
    }
  }
}

async function runPush(env: Env, pushId: string, attempt: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT
       pu.id, pu.user_id, pu.candidate_id, pu.status,
       c.anchor_text, c.paragraph_excerpt,
       op.slug AS orphan_slug,
       sp.id   AS source_page_id, sp.slug AS source_slug,
       s.id    AS site_id, s.url AS site_url, s.cms,
       s.wp_username, s.wp_app_password
     FROM pushes pu
     JOIN candidates c  ON c.id = pu.candidate_id
     JOIN pages op      ON op.id = c.orphan_page_id
     JOIN pages sp      ON sp.id = c.source_page_id
     JOIN sites s       ON s.id = sp.site_id
     WHERE pu.id = ?`
  )
    .bind(pushId)
    .first<{
      id: string;
      user_id: string;
      candidate_id: string;
      status: string;
      anchor_text: string;
      paragraph_excerpt: string;
      orphan_slug: string;
      source_page_id: string;
      source_slug: string;
      site_id: string;
      site_url: string;
      cms: string;
      wp_username: string | null;
      wp_app_password: Uint8Array | null;
    }>();

  if (!row) {
    console.warn('push not found', { pushId });
    return false;
  }
  if (row.status !== 'pending') {
    return false; // already processed
  }
  if (row.cms !== 'wordpress') {
    await markFailure(env, pushId, 'wp_unknown', 'cms not yet supported');
    return false;
  }

  // Resolve source slug → wp post id. We rely on the wp endpoint /wp/v2/posts
  // with slug filter; cache by slug in KV with 24h TTL to avoid hammering.
  // D1 returns BLOB as ArrayBuffer; decrypt needs a Uint8Array view, so wrap.
  const encryptedSecret = row.wp_app_password ? new Uint8Array(row.wp_app_password as ArrayBuffer) : null;
  const resolved = await resolveSlugToPostId(env, row.source_page_id, row.site_url, row.source_slug, row.wp_username, encryptedSecret);
  // A transient failure reaching WP during slug resolution (timeout, network,
  // 5xx) must NOT be recorded as a permanent wp_post_not_found — that flips the
  // core action to a dead "failed" the user has to manually retry over a blip.
  // Retry it on the same bounded schedule as a failed pushLink; only give up
  // (as wp_network) after MAX_RETRY. (Hardened 2026-06-07.)
  if (resolved === 'transient') {
    if (attempt < MAX_RETRY) return true;
    await markFailure(env, pushId, 'wp_network', `could not reach ${row.site_url} to resolve source post after ${MAX_RETRY} attempts`);
    return false;
  }
  if (resolved === null) {
    // Genuine not-found / bad credential — retrying won't change the answer.
    await markFailure(env, pushId, 'wp_post_not_found', `slug ${row.source_slug} not resolvable`);
    return false;
  }
  const postId = resolved;

  const targetHref = new URL(row.orphan_slug, row.site_url).toString();
  const outcome: PushOutcome = await pushLink(env, {
    siteUrl: row.site_url,
    username: row.wp_username,
    encryptedSecret: row.wp_app_password ? new Uint8Array(row.wp_app_password) : null,
    postId,
    anchorText: row.anchor_text,
    targetHref,
    paragraphMarker: row.paragraph_excerpt,
  });

  if (outcome.ok) {
    // 'pushed' = written to the CMS, awaiting verification. Distinct from the
    // 'pending' a push starts in. Cloudflare Queues are at-least-once: if this
    // message is redelivered (consumer crashed after the CMS write but before
    // ack), the guard above (`status !== 'pending'`) now short-circuits it
    // instead of re-pushing. (Hardened 2026-06-06.)
    await env.DB.prepare(
      `UPDATE pushes
          SET status = 'pushed',
              pushed_at = ?,
              failure_code = NULL,
              failure_msg = NULL
        WHERE id = ?`
    )
      .bind(outcome.insertedAt, pushId)
      .run();
    await env.Q_VERIFY.send({ pushId, attempt: 1 });
    return false;
  }

  // wp_already_linked means the link IS present in the post — the user's goal is
  // met. This is overwhelmingly a redelivered q-push re-running a push we already
  // completed (the insertLink marker / target href is already in the HTML). Treat
  // it as a success and let the verifier confirm the live link, rather than
  // flipping a real success to 'failed'. (Hardened 2026-06-06.)
  if (outcome.code === 'wp_already_linked') {
    await env.DB.prepare(
      `UPDATE pushes
          SET status = 'pushed',
              pushed_at = ?,
              failure_code = NULL,
              failure_msg = NULL
        WHERE id = ?`
    )
      .bind(Date.now(), pushId)
      .run();
    await env.Q_VERIFY.send({ pushId, attempt: 1 });
    return false;
  }

  // Failure path.
  const retryable =
    outcome.code === 'wp_network' || outcome.code === 'wp_post_failed';
  if (retryable && attempt < MAX_RETRY) {
    return true;
  }
  await markFailure(env, pushId, outcome.code, outcome.message ?? null);
  return false;
}

async function markFailure(
  env: Env,
  pushId: string,
  code: string,
  msg: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE pushes
        SET status = 'failed',
            failure_code = ?,
            failure_msg = ?,
            pushed_at = ?
      WHERE id = ?`
  )
    .bind(code, msg, Date.now(), pushId)
    .run();
}

// Returns the post id, `null` for a PERMANENT miss (genuine not-found, missing/
// bad credential — retrying won't help), or the sentinel `'transient'` when WP
// could not be reached (timeout, network, 5xx) so the caller can retry instead
// of recording a permanent failure.
async function resolveSlugToPostId(
  env: Env,
  pageId: string,
  siteUrl: string,
  slug: string,
  username: string | null,
  encrypted: Uint8Array | null
): Promise<number | null | 'transient'> {
  // Cache hit?
  const cacheKey = `wp:slug:${pageId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return Number(cached);
  if (!encrypted) return null;

  // Decrypt + Basic auth + query.
  const { decrypt } = await import('../lib/crypto');
  let secret: string;
  try {
    secret = await decrypt(encrypted, env.RECTO_KEK);
  } catch {
    return null; // bad stored credential — permanent, not a blip
  }
  const auth = secret.startsWith('jwt:')
    ? `Bearer ${secret.slice(4)}`
    : `Basic ${btoa(`${username ?? ''}:${secret.replace(/\s+/g, '')}`)}`;

  // Strip leading slash, trim trailing.
  const wpSlug = slug.replace(/^\/+/, '').replace(/\/+$/, '').split('/').pop() ?? '';
  if (!wpSlug) return null;

  const url = `${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts?slug=${encodeURIComponent(wpSlug)}&_fields=id`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: auth, 'User-Agent': 'recto/1.0' } }, WP_TIMEOUT_MS);
  } catch {
    return 'transient'; // timeout / network error — WP may just be briefly down
  }
  // 5xx is the host failing, not a definitive "no such post" — retry it.
  if (res.status >= 500) return 'transient';
  // 4xx (auth, 404) is a definitive answer for this request — permanent.
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => [])) as Array<{ id: number }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const id = rows[0]?.id;
  if (typeof id !== 'number') return null;
  await env.KV.put(cacheKey, String(id), { expirationTtl: 24 * 60 * 60 });
  return id;
}
