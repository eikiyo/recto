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

type PushMsg = { pushId: string };

const MAX_RETRY = 3;

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
      console.error('push error', { pushId: msg.body.pushId, error: (e as Error).message });
      msg.retry({ delaySeconds: 30 });
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
  const postId = await resolveSlugToPostId(env, row.source_page_id, row.site_url, row.source_slug, row.wp_username, encryptedSecret);
  if (!postId) {
    await markFailure(env, pushId, 'wp_post_not_found', `slug ${row.source_slug} not resolvable`);
    return false;
  }

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
    await env.DB.prepare(
      `UPDATE pushes
          SET status = 'pending',
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

async function resolveSlugToPostId(
  env: Env,
  pageId: string,
  siteUrl: string,
  slug: string,
  username: string | null,
  encrypted: Uint8Array | null
): Promise<number | null> {
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
    return null;
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
    res = await fetch(url, { headers: { Authorization: auth, 'User-Agent': 'recto/1.0' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const rows = (await res.json().catch(() => [])) as Array<{ id: number }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const id = rows[0]?.id;
  if (typeof id !== 'number') return null;
  await env.KV.put(cacheKey, String(id), { expirationTtl: 24 * 60 * 60 });
  return id;
}
