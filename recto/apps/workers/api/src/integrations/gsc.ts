// Google Search Console — OAuth 2.0 client + Search Analytics API client.
// Scope: webmasters.readonly. We never write.

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SC_API = 'https://searchconsole.googleapis.com/webmasters/v3';

export type GscTokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: 'Bearer';
};

export type GscProperty = {
  siteUrl: string; // e.g. 'sc-domain:example.com' or 'https://example.com/'
  permissionLevel: 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser';
};

export type GscSearchAnalyticsRow = {
  keys: string[]; // when dimensions = ['page'], keys[0] is the URL
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
};

export function authorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const u = new URL(AUTH_BASE);
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent'); // always request refresh_token
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', args.state);
  if (args.loginHint) u.searchParams.set('login_hint', args.loginHint);
  return u.toString();
}

export async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<GscTokenSet> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gsc_exchange_failed:${res.status}:${text.slice(0, 200)}`);
  }
  return (await res.json()) as GscTokenSet;
}

export async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GscTokenSet> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 400 invalid_grant means the user revoked at myaccount.google.com — surface as reauth.
    if (res.status === 400 && /invalid_grant/i.test(text)) {
      throw new Error('gsc_reauth_required');
    }
    throw new Error(`gsc_refresh_failed:${res.status}:${text.slice(0, 200)}`);
  }
  return (await res.json()) as GscTokenSet;
}

export async function listProperties(accessToken: string): Promise<GscProperty[]> {
  const res = await fetch(`${SC_API}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gsc_list_failed:${res.status}`);
  const json = (await res.json()) as { siteEntry?: GscProperty[] };
  return json.siteEntry ?? [];
}

/**
 * Pull Search Analytics rows for a single day, grouped by page URL.
 * Page-level dimension is the cheapest cardinality and what recto needs.
 */
export async function searchAnalyticsPage(args: {
  accessToken: string;
  siteUrl: string;
  day: string; // YYYY-MM-DD
  rowLimit?: number;
}): Promise<GscSearchAnalyticsRow[]> {
  const endpoint = `${SC_API}/sites/${encodeURIComponent(args.siteUrl)}/searchAnalytics/query`;
  const body = {
    startDate: args.day,
    endDate: args.day,
    dimensions: ['page'],
    rowLimit: args.rowLimit ?? 5000,
    dataState: 'final' as const,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('gsc_quota');
    throw new Error(`gsc_query_failed:${res.status}`);
  }
  const json = (await res.json()) as { rows?: GscSearchAnalyticsRow[] };
  return json.rows ?? [];
}

/**
 * Normalize a property identifier into the canonical URL prefix used as the
 * Search Console path parameter. `sc-domain:example.com` stays as-is; everything
 * else is URL-encoded by the caller.
 */
export function isDomainProperty(siteUrl: string): boolean {
  return siteUrl.startsWith('sc-domain:');
}
