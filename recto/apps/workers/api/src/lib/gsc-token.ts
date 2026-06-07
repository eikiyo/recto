// Small helper: given a siteId, return a fresh access token by decrypting the
// stored refresh token and exchanging it. Surfaces gsc_reauth_required cleanly.

import type { Env } from '../env';
import { decrypt } from './crypto';
import { refreshAccessToken } from '../integrations/gsc';

const TOKEN_CACHE_PREFIX = 'gsc:at:';
// Refresh a little before Google's stated expiry so an in-flight request never
// uses a token that lapses mid-call.
const TOKEN_REFRESH_BUFFER_S = 300;

// Drop the cached access token for a site. MUST be called whenever the stored
// refresh token or property changes (connect / reconnect / property select /
// disconnect / reauth) — otherwise a multi-day backfill could keep using a
// token tied to the old connection/property for up to the cache TTL.
export async function invalidateGscTokenCache(env: Env, siteId: string): Promise<void> {
  await env.KV.delete(TOKEN_CACHE_PREFIX + siteId);
}

export async function accessTokenForSite(
  env: Env,
  siteId: string
): Promise<{ accessToken: string; property: string } | { error: 'gsc_not_connected' | 'gsc_reauth_required' }> {
  // Cache the short-lived (~1 h) access token in KV. A 90-day backfill fans out
  // one queue message per day, each calling this — without the cache that is
  // ~89 refresh-token exchanges against Google's rate-limited token endpoint
  // per backfill (slow + can trip quota → failed days). The cache collapses
  // that to ~1-2 exchanges. (Hardened 2026-06-07.)
  const cacheKey = TOKEN_CACHE_PREFIX + siteId;
  const cached = (await env.KV.get(cacheKey, 'json')) as { accessToken: string; property: string } | null;
  if (cached && cached.accessToken && cached.property) return cached;

  const row = await env.DB.prepare(
    'SELECT gsc_refresh_token, gsc_property FROM sites WHERE id = ?'
  )
    .bind(siteId)
    .first<{ gsc_refresh_token: Uint8Array | null; gsc_property: string | null }>();

  if (!row || !row.gsc_refresh_token || !row.gsc_property) {
    return { error: 'gsc_not_connected' };
  }

  const refreshToken = await decrypt(row.gsc_refresh_token, env.RECTO_KEK);
  try {
    const tokens = await refreshAccessToken({
      clientId: env.GSC_CLIENT_ID,
      clientSecret: env.GSC_CLIENT_SECRET,
      refreshToken,
    });
    const result = { accessToken: tokens.access_token, property: row.gsc_property };
    const ttl = Math.max(60, (tokens.expires_in ?? 3600) - TOKEN_REFRESH_BUFFER_S);
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl });
    return result;
  } catch (e) {
    if ((e as Error).message === 'gsc_reauth_required') {
      await env.DB.prepare('UPDATE sites SET gsc_refresh_token = NULL WHERE id = ?').bind(siteId).run();
      await invalidateGscTokenCache(env, siteId);
      return { error: 'gsc_reauth_required' };
    }
    throw e;
  }
}

export function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns YYYY-MM-DD for "today minus N days" in UTC. */
export function nDaysAgo(n: number): string {
  return isoDay(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}
