// Small helper: given a siteId, return a fresh access token by decrypting the
// stored refresh token and exchanging it. Surfaces gsc_reauth_required cleanly.

import type { Env } from '../env';
import { decrypt } from './crypto';
import { refreshAccessToken } from '../integrations/gsc';

export async function accessTokenForSite(
  env: Env,
  siteId: string
): Promise<{ accessToken: string; property: string } | { error: 'gsc_not_connected' | 'gsc_reauth_required' }> {
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
    return { accessToken: tokens.access_token, property: row.gsc_property };
  } catch (e) {
    if ((e as Error).message === 'gsc_reauth_required') {
      await env.DB.prepare('UPDATE sites SET gsc_refresh_token = NULL WHERE id = ?').bind(siteId).run();
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
