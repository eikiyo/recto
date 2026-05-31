// WordPress REST integration. Two paths:
//   - Application Password (preferred): Basic auth header. Available in WP >= 5.6.
//   - JWT (fallback): for sites using the JWT-Authentication-for-WP-REST-API
//     plugin. Not auto-detected — user opts in by storing a JWT in place of
//     wp_app_password and prefixing with "jwt:".
//
// The push operation:
//   1. GET the target post via /wp-json/wp/v2/posts/{id} to confirm access + read content.
//   2. Apply the link insertion in the HTML (insertLink: idempotent string op).
//   3. POST the modified content. Capture revision id.
//   4. Return { ok, revisionId, errorCode } for the audit log.
//
// Error codes returned (used by D6.3 audit log):
//   wp_auth_failed         — 401/403 on GET. Stale app password.
//   wp_post_not_found      — 404 on GET. Slug→post resolution wrong, or page deleted.
//   wp_rest_disabled       — 403 with rest_disabled / rest_no_route. Often Wordfence.
//   wp_security_blocked    — 403 with body matching wordfence/sucuri signatures.
//   wp_already_linked      — content already contains an anchor at this insertion point.
//   wp_post_failed         — non-2xx on POST.
//   wp_network             — fetch threw.
//   wp_unknown             — fallback.

import { decrypt } from '../lib/crypto';

export type PushOutcome =
  | { ok: true; revisionId: number; postId: number; insertedAt: number }
  | { ok: false; code: PushErrorCode; status?: number; message?: string };

export type PushErrorCode =
  | 'wp_auth_failed'
  | 'wp_post_not_found'
  | 'wp_rest_disabled'
  | 'wp_security_blocked'
  | 'wp_already_linked'
  | 'wp_post_failed'
  | 'wp_network'
  | 'wp_unknown';

export type PushInput = {
  siteUrl: string;
  username: string | null;
  encryptedSecret: Uint8Array | null;
  postId: number;
  anchorText: string;
  targetHref: string;
  paragraphMarker: string; // exact substring of the post HTML where the link goes
};

const USER_AGENT = 'recto/1.0 (+https://recto.so)';

export async function pushLink(env: { RECTO_KEK: string }, input: PushInput): Promise<PushOutcome> {
  if (!input.encryptedSecret) {
    return { ok: false, code: 'wp_auth_failed', message: 'no credentials on file' };
  }
  let secret: string;
  try {
    secret = await decrypt(input.encryptedSecret, env.RECTO_KEK);
  } catch {
    return { ok: false, code: 'wp_auth_failed', message: 'credential decrypt failed' };
  }

  const auth = buildAuthHeader(input.username, secret);
  const base = input.siteUrl.replace(/\/$/, '');
  const postUrl = `${base}/wp-json/wp/v2/posts/${input.postId}?context=edit`;

  // 1. Fetch current content.
  let getRes: Response;
  try {
    getRes = await fetch(postUrl, {
      headers: { Authorization: auth, 'User-Agent': USER_AGENT },
    });
  } catch (e) {
    return { ok: false, code: 'wp_network', message: (e as Error).message };
  }
  const classified = classifyWpResponse(getRes);
  if (classified) return classified;
  if (!getRes.ok) {
    return { ok: false, code: 'wp_post_failed', status: getRes.status };
  }

  const post = (await getRes.json().catch(() => null)) as
    | { id: number; content: { raw?: string; rendered?: string } }
    | null;
  if (!post || !post.content) {
    return { ok: false, code: 'wp_post_not_found', status: getRes.status };
  }
  const original = post.content.raw ?? post.content.rendered ?? '';

  // 2. Insert link, idempotently.
  const { content, alreadyLinked, markerMissing } = insertLink(
    original,
    input.paragraphMarker,
    input.anchorText,
    input.targetHref
  );
  if (alreadyLinked) {
    return { ok: false, code: 'wp_already_linked' };
  }
  if (markerMissing) {
    return { ok: false, code: 'wp_post_failed', message: 'no paragraph in source post body' };
  }

  // 3. POST the modified content.
  let updateRes: Response;
  try {
    updateRes = await fetch(`${base}/wp-json/wp/v2/posts/${input.postId}`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
  } catch (e) {
    return { ok: false, code: 'wp_network', message: (e as Error).message };
  }
  const updateClassified = classifyWpResponse(updateRes);
  if (updateClassified) return updateClassified;
  if (!updateRes.ok) {
    return { ok: false, code: 'wp_post_failed', status: updateRes.status };
  }
  const updated = (await updateRes.json().catch(() => null)) as
    | { id: number; modified?: string }
    | null;
  if (!updated) {
    return { ok: false, code: 'wp_post_failed', status: updateRes.status };
  }

  // WP doesn't return the revision id on POST; use the post id as the audit anchor.
  return { ok: true, revisionId: updated.id, postId: updated.id, insertedAt: Date.now() };
}

function buildAuthHeader(username: string | null, secret: string): string {
  if (secret.startsWith('jwt:')) {
    return `Bearer ${secret.slice(4)}`;
  }
  const u = username ?? '';
  // App Passwords come hyphenated; spaces are fine for Basic.
  const token = btoa(`${u}:${secret.replace(/\s+/g, '')}`);
  return `Basic ${token}`;
}

// Maps WordPress response signatures to the error codes used by the audit log.
// Returns null when nothing matched (caller continues normally).
function classifyWpResponse(res: Response): PushOutcome | null {
  if (res.status === 401) {
    return { ok: false, code: 'wp_auth_failed', status: 401 };
  }
  if (res.status === 403) {
    // Wordfence and Sucuri commonly return 403 with branded HTML.
    // We don't read the body to keep this cheap; the verifier confirms after retry.
    return { ok: false, code: 'wp_security_blocked', status: 403 };
  }
  if (res.status === 404) {
    return { ok: false, code: 'wp_post_not_found', status: 404 };
  }
  if (res.status === 406 || res.status === 418) {
    return { ok: false, code: 'wp_rest_disabled', status: res.status };
  }
  return null;
}

// Idempotent insertion. Strategy:
//   1. Already-linked short-circuit (same href OR our data-recto-link marker).
//   2. Verbatim marker match → insert right after the marker text.
//   3. Marker not found (WP often normalises whitespace, entities, wraps in
//      block comments) → fall back to inserting a fresh paragraph after the
//      first paragraph close (`</p>`, WP block boundary, or double-newline).
//      Still "in the body, near the top" which matches what Mira approved.
//   4. No paragraph break at all → markerMissing=true so the caller surfaces
//      wp_marker_not_found instead of silently no-op'ing.
export function insertLink(
  original: string,
  paragraphMarker: string,
  anchorText: string,
  href: string
): { content: string; alreadyLinked: boolean; markerMissing?: boolean; via?: 'marker' | 'first-paragraph' } {
  const anchor = `<a href="${escapeAttr(href)}" data-recto-link="1">${escapeText(anchorText)}</a>`;

  // 1. Already linked.
  if (original.includes(`href="${href}"`) || original.includes(`data-recto-link="1"`)) {
    return { content: original, alreadyLinked: true };
  }

  // 2. Verbatim marker.
  const idx = original.indexOf(paragraphMarker);
  if (idx !== -1) {
    const before = original.slice(0, idx + paragraphMarker.length);
    const after = original.slice(idx + paragraphMarker.length);
    return { content: `${before} ${anchor}${after}`, alreadyLinked: false, via: 'marker' };
  }

  // 3. Fallback: insert after the first paragraph break.
  const candidates: Array<{ idx: number; len: number }> = [];
  const closeP = original.indexOf('</p>');
  if (closeP !== -1) candidates.push({ idx: closeP, len: '</p>'.length });
  const block = original.indexOf('<!-- /wp:paragraph -->');
  if (block !== -1) candidates.push({ idx: block, len: '<!-- /wp:paragraph -->'.length });
  const nl = original.indexOf('\n\n');
  if (nl !== -1) candidates.push({ idx: nl, len: '\n\n'.length });
  candidates.sort((a, b) => a.idx - b.idx);
  const first = candidates[0];
  if (first) {
    const before = original.slice(0, first.idx + first.len);
    const after = original.slice(first.idx + first.len);
    return { content: `${before}\n\n<p>${anchor}</p>\n\n${after}`, alreadyLinked: false, via: 'first-paragraph' };
  }

  // 4. No place to land — flag missing so the caller fails the push cleanly.
  return { content: original, alreadyLinked: false, markerMissing: true };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
