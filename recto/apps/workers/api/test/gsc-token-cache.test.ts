// Hardening/perf regression (2026-06-07): a 90-day GSC backfill fans out one
// queue message per day, each calling accessTokenForSite. Without the KV cache
// that's ~89 refresh-token exchanges against Google's rate-limited token
// endpoint per backfill. This test proves the access token is cached (one
// exchange serves repeated calls) and that invalidation forces a fresh
// exchange (so a reconnect / property change can't keep using a stale token).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/integrations/gsc', () => ({
  refreshAccessToken: vi.fn(async () => ({ access_token: 'AT-1', expires_in: 3600, refresh_token: 'RT' })),
}));
vi.mock('../src/lib/crypto', () => ({
  decrypt: vi.fn(async () => 'refresh-token-plain'),
}));

import { accessTokenForSite, invalidateGscTokenCache } from '../src/lib/gsc-token';
import { refreshAccessToken } from '../src/integrations/gsc';

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string, _type?: string) => {
      const v = store.get(k);
      return v ? JSON.parse(v) : null;
    }),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
}

function makeEnv(KV: ReturnType<typeof makeKv>) {
  return {
    KV,
    RECTO_KEK: 'kek',
    GSC_CLIENT_ID: 'cid',
    GSC_CLIENT_SECRET: 'csec',
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ gsc_refresh_token: new Uint8Array([1, 2, 3]), gsc_property: 'sc-domain:example.com' }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    },
  } as unknown as Parameters<typeof accessTokenForSite>[0];
}

describe('accessTokenForSite — KV access-token cache', () => {
  beforeEach(() => { (refreshAccessToken as ReturnType<typeof vi.fn>).mockClear(); });

  it('exchanges once, then serves repeated calls from cache', async () => {
    const KV = makeKv();
    const env = makeEnv(KV);

    const a = await accessTokenForSite(env, 'site1');
    const b = await accessTokenForSite(env, 'site1');
    const c = await accessTokenForSite(env, 'site1');

    expect(a).toEqual({ accessToken: 'AT-1', property: 'sc-domain:example.com' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // 89-day backfill would have been 89 exchanges; cache makes it 1.
    expect((refreshAccessToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(KV.put).toHaveBeenCalledTimes(1);
  });

  it('invalidation forces a fresh exchange (reconnect / property change safe)', async () => {
    const KV = makeKv();
    const env = makeEnv(KV);

    await accessTokenForSite(env, 'site1');                 // exchange #1 + cache
    await invalidateGscTokenCache(env, 'site1');            // drop cache
    expect(KV.delete).toHaveBeenCalledWith('gsc:at:site1');
    await accessTokenForSite(env, 'site1');                 // must exchange again

    expect((refreshAccessToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('caches per-site (no cross-site bleed)', async () => {
    const KV = makeKv();
    const env = makeEnv(KV);
    await accessTokenForSite(env, 'siteA');
    await accessTokenForSite(env, 'siteB'); // different key → its own exchange
    expect((refreshAccessToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(KV.store.has('gsc:at:siteA')).toBe(true);
    expect(KV.store.has('gsc:at:siteB')).toBe(true);
  });
});
