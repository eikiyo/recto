// Hardening regression (2026-06-07): parseCookie() split each cookie on EVERY
// '=' and kept only the second field, truncating any value containing '='. Today
// session values are b64url (no padding) so it happened to work — but it's a
// silent landmine: switch the session/sig encoding to anything with '=' (base64
// padding, a JWT) and EVERY login breaks with no error. Fix: split on the first
// '=' only. This drives the REAL loadSession with a '='-bearing cookie value and
// asserts the whole value survives (old code returned null).

import { describe, it, expect, vi } from 'vitest';

// Force HMAC verify to pass so we can use an arbitrary (=-bearing) value.
vi.mock('../src/lib/crypto', () => ({
  verify: vi.fn(async () => true),
  sign: vi.fn(async () => 'sig'),
  randomToken: vi.fn(() => 'rand'),
}));

import { loadSession } from '../src/auth/session';
import type { Env } from '../src/env';

function envWithSession(expectSessionId: string) {
  return {
    MAGIC_LINK_SECRET: 'secret',
    DB: {
      prepare: (_sql: string) => ({
        bind: (sessionId: string) => ({
          first: async () =>
            sessionId === expectSessionId
              ? { user_id: 'u1', expires_at: Date.now() + 60_000 }
              : null,
        }),
      }),
    },
  } as unknown as Env;
}

describe('parseCookie via loadSession — values containing "=" are not truncated', () => {
  it('extracts the full cookie value (id + sig both contain "=")', async () => {
    // value = "ses=sion.sig==" → loadSession splits at the LAST '.' →
    // sessionId="ses=sion", sig="sig==". The whole value must reach loadSession.
    const env = envWithSession('ses=sion');
    const got = await loadSession(env, 'recto_session=ses=sion.sig==');
    expect(got).toEqual({ userId: 'u1', sessionId: 'ses=sion' });
  });

  it('still picks the right cookie when other "="-laden cookies precede it', async () => {
    const env = envWithSession('sid123');
    const header = 'ab_test=x=y=z; recto_session=sid123.abc; tracking=q=1';
    const got = await loadSession(env, header);
    expect(got).toEqual({ userId: 'u1', sessionId: 'sid123' });
  });

  it('returns null when the session cookie is absent', async () => {
    const env = envWithSession('sid123');
    expect(await loadSession(env, 'other=1; foo=bar=baz')).toBeNull();
  });
});
