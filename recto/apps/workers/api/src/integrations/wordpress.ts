// WordPress REST integration. Two paths:
//   - Application Password (preferred): Basic auth header. Available in WP >= 5.6.
//   - JWT (fallback): for sites using the JWT-Authentication-for-WP-REST-API
//     plugin. Not auto-detected — user opts in by storing a JWT in place of
//     wp_app_password and prefixing with "jwt:".
//
// The push operation:
//   1. GET the target post via /wp-json/wp/v2/posts/{id} to confirm access + read content.
//   2. Wrap the existing anchor phrase in place (insertLink: never authors text).
//   3. POST the modified content. Capture revision id.
//   4. Return { ok, revisionId, errorCode } for the audit log.
//
// Error codes returned (used by D6.3 audit log):
//   wp_auth_failed         — 401/403 on GET. Stale app password.
//   wp_post_not_found      — 404 on GET. Slug→post resolution wrong, or page deleted.
//   wp_rest_disabled       — 403 with rest_disabled / rest_no_route. Often Wordfence.
//   wp_security_blocked    — 403 with body matching wordfence/sucuri signatures.
//   wp_already_linked      — the orphan is already linked in this post.
//   wp_anchor_not_found    — the selected phrase isn't in the live post verbatim.
//   wp_post_failed         — non-2xx on POST.
//   wp_network             — fetch threw.
//   wp_unknown             — fallback.

import { decrypt } from '../lib/crypto';
import { findPhrase } from '../lib/phrase';
import { fetchWithTimeout } from '../lib/http';

// Untrusted WordPress hosts can hang; bound every call so a slow site can't pin
// a q-push / connect Worker invocation. (Hardened 2026-06-06.)
const WP_TIMEOUT_MS = 10_000;

export type PushOutcome =
  | { ok: true; revisionId: number; postId: number; insertedAt: number }
  | { ok: false; code: PushErrorCode; status?: number; message?: string };

export type PushErrorCode =
  | 'wp_auth_failed'
  | 'wp_post_not_found'
  | 'wp_rest_disabled'
  | 'wp_security_blocked'
  | 'wp_already_linked'
  | 'wp_anchor_not_found'
  | 'wp_post_failed'
  | 'wp_network'
  | 'wp_invalid_response'
  | 'wp_unknown';

export type PushInput = {
  siteUrl: string;
  username: string | null;
  encryptedSecret: Uint8Array | null;
  postId: number;
  anchorText: string; // the EXISTING phrase to wrap (must be verbatim in the post)
  targetHref: string;
  paragraphMarker: string; // scope hint: the paragraph the phrase was selected from
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
    getRes = await fetchWithTimeout(postUrl, {
      headers: { Authorization: auth, 'User-Agent': USER_AGENT },
    }, WP_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, code: 'wp_network', message: (e as Error).message };
  }
  const classified = classifyWpResponse(getRes);
  if (classified) return classified;
  if (!getRes.ok) {
    return { ok: false, code: 'wp_post_failed', status: getRes.status };
  }

  // A 2xx whose body is not valid JSON (a caching/security plugin returning HTML,
  // a truncated response) is NOT "post not found" — surface it as a distinct,
  // truthful error so the audit log and the user aren't misled. (Hardened 2026-06-06.)
  let post: { id: number; content: { raw?: string; rendered?: string } } | null;
  try {
    post = (await getRes.json()) as { id: number; content: { raw?: string; rendered?: string } } | null;
  } catch {
    return { ok: false, code: 'wp_invalid_response', status: getRes.status, message: 'non-JSON body on GET post' };
  }
  if (!post || !post.content) {
    return { ok: false, code: 'wp_post_not_found', status: getRes.status };
  }
  const original = post.content.raw ?? post.content.rendered ?? '';

  // 2. Wrap the existing phrase in place, idempotently.
  const { content, alreadyLinked, phraseNotFound } = insertLink(
    original,
    input.anchorText,
    input.targetHref,
    input.paragraphMarker
  );
  if (alreadyLinked) {
    return { ok: false, code: 'wp_already_linked' };
  }
  if (phraseNotFound) {
    // The selected phrase is no longer present verbatim in the live post (post
    // edited since crawl, or whitespace/entity drift). We NEVER fabricate text
    // or append a paragraph — fail cleanly so the user can re-pick a phrase.
    return { ok: false, code: 'wp_anchor_not_found', message: 'anchor phrase not found in post' };
  }

  // 3. POST the modified content.
  let updateRes: Response;
  try {
    updateRes = await fetchWithTimeout(`${base}/wp-json/wp/v2/posts/${input.postId}`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    }, WP_TIMEOUT_MS);
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

// Verify WordPress credentials at CONNECT time, before we store them. Previously
// connect only checked the fields were non-empty, so a wrong username, a login
// password used in place of an Application Password, or a typo stored silently —
// and the FIRST real auth attempt was the push, which 401'd as wp_auth_failed
// long after the user thought they were connected. (This was the true cause of
// the "connect isn't working" customer report, 2026-06-06.) We hit the exact
// endpoint a push needs — posts?context=edit — so a green connect guarantees a
// push can authenticate AND has edit capability.
export async function verifyWpCredentials(input: {
  siteUrl: string;
  username: string;
  appPassword: string;
}): Promise<{ ok: true } | { ok: false; code: 'wp_auth_failed' | 'wp_no_edit_access' | 'wp_rest_disabled' | 'wp_network'; status?: number }> {
  const base = input.siteUrl.replace(/\/$/, '');
  const auth = buildAuthHeader(input.username, input.appPassword);
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/wp-json/wp/v2/posts?context=edit&per_page=1`, {
      headers: { Authorization: auth, 'User-Agent': USER_AGENT },
    }, WP_TIMEOUT_MS);
  } catch {
    return { ok: false, code: 'wp_network' };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, code: 'wp_auth_failed', status: 401 };
  if (res.status === 403) return { ok: false, code: 'wp_no_edit_access', status: 403 };
  if (res.status === 404 || res.status === 406 || res.status === 418) {
    return { ok: false, code: 'wp_rest_disabled', status: res.status };
  }
  return { ok: false, code: 'wp_auth_failed', status: res.status };
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

// Wrap an EXISTING phrase in place. This is the core value prop: we never author
// anchor text and never append a paragraph — we take a phrase that already lives
// in the post body and turn exactly that run of words into a link, leaving every
// other character of the blog untouched. Strategy:
//   1. Already-linked short-circuit (same href OR our data-recto-link marker).
//   2. Locate the phrase (whitespace-flexible, never crossing a tag, never
//      inside an existing <a>), preferring the paragraph it was selected from.
//   3. Wrap that exact occurrence: text → <a …>text</a>. The inner text is the
//      blog's own words, verbatim — we do not re-escape or alter it.
//   4. Phrase absent → phraseNotFound=true so the caller fails cleanly. We NEVER
//      fall back to inserting new text. (Rebuilt 2026-06-06.)
export function insertLink(
  original: string,
  anchorPhrase: string,
  href: string,
  scopeHint?: string
): { content: string; alreadyLinked: boolean; phraseNotFound?: boolean; via?: 'wrap' } {
  // 1. Already linked TO THIS ORPHAN. Idempotency must be keyed on the SPECIFIC
  //    target href (matched in the exact escaped form we emit below), NOT on the
  //    presence of ANY recto link. The old `|| data-recto-link="1"` catch-all
  //    rejected every push to a post that already held one recto link — so a
  //    high-authority hub post (the best source for MANY orphans) could link
  //    exactly ONE orphan ever: the 2nd+ pushes short-circuited as
  //    wp_already_linked, the link was never inserted, and the verifier (which
  //    keys on the orphan's own href) then found it absent. findPhrase already
  //    refuses to wrap inside an existing <a>, so adding a 2nd distinct link is
  //    safe and never nests. (Fixed 2026-06-07 — core multi-link value path.)
  if (original.includes(`href="${escapeAttr(href)}"`)) {
    return { content: original, alreadyLinked: true };
  }

  // 2. Find the existing phrase to wrap.
  const hit = findPhrase(original, anchorPhrase, scopeHint);
  if (!hit) {
    return { content: original, alreadyLinked: false, phraseNotFound: true };
  }

  // 3. Wrap the blog's own words in place.
  const before = original.slice(0, hit.start);
  const after = original.slice(hit.end);
  const anchor = `<a href="${escapeAttr(href)}" data-recto-link="1">${hit.matched}</a>`;
  return { content: `${before}${anchor}${after}`, alreadyLinked: false, via: 'wrap' };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
