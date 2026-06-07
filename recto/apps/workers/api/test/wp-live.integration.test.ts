// LIVE WordPress integration test — runs ONLY when WP_URL is set.
//
// Drives the real `pushLink` (the exact code prod uses) against a real
// WordPress over its REST API, authenticating with a brand-new WP user's
// Application Password — i.e. the precise flow a customer follows when they
// "fetch a username and password from their WP user" and connect to Recto.
//
// Run via fixtures/wp-bigsite/run-live-test.sh (sets the env from the live
// Docker container). Skipped in the normal unit suite.

import { describe, it, expect } from 'vitest';
import { pushLink, type PushInput } from '../src/integrations/wordpress';
import { encrypt } from '../src/lib/crypto';

const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER ?? '';
const WP_APP_PWD = process.env.WP_APP_PWD ?? '';
const WP_SRC_ID = Number(process.env.WP_SRC_ID ?? '0');
const WP_TARGET_HREF = process.env.WP_TARGET_HREF ?? '';
const WP_MARKER = process.env.WP_MARKER ?? '';

// 32-byte base64 test KEK (zeros) — only used to round-trip the app password.
const KEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function baseInput(over: Partial<PushInput> = {}): Promise<PushInput> {
  return {
    siteUrl: WP_URL!,
    username: WP_USER,
    encryptedSecret: await encrypt(WP_APP_PWD, KEK),
    postId: WP_SRC_ID,
    anchorText: 'related orphan page',
    targetHref: WP_TARGET_HREF,
    paragraphMarker: WP_MARKER,
    ...over,
  };
}

async function fetchRaw(postId: number): Promise<string> {
  const auth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PWD.replace(/\s+/g, '')}`).toString('base64');
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${postId}?context=edit`, {
    headers: { Authorization: auth },
  });
  const j = (await res.json()) as { content?: { raw?: string } };
  return j.content?.raw ?? '';
}

describe.skipIf(!WP_URL)('LIVE WordPress push (real REST, brand-new user app password)', () => {
  it('happy path: inserts the link and WordPress persists it', async () => {
    const out = await pushLink({ RECTO_KEK: KEK }, await baseInput());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.postId).toBe(WP_SRC_ID);
      expect(out.revisionId).toBeGreaterThan(0);
    }
    // Confirm WordPress actually saved the anchor.
    const raw = await fetchRaw(WP_SRC_ID);
    expect(raw).toContain('data-recto-link="1"');
    expect(raw).toContain(WP_TARGET_HREF);
  }, 30_000);

  it('idempotent: a second push reports already-linked, does not double-insert', async () => {
    const out = await pushLink({ RECTO_KEK: KEK }, await baseInput());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('wp_already_linked');
  }, 30_000);

  it('bad app password → wp_auth_failed (the customer\'s "wrong creds" case)', async () => {
    const out = await pushLink(
      { RECTO_KEK: KEK },
      await baseInput({ encryptedSecret: await encrypt('wrong-pass-word-1234', KEK), postId: WP_SRC_ID }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('wp_auth_failed');
  }, 30_000);
});
