import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { requireSession, type AuthVars } from '../auth/middleware';
import { encrypt, decrypt, randomToken, sign, verify } from '../lib/crypto';
import {
  authorizeUrl,
  exchangeCode,
  listProperties,
  type GscProperty,
} from '../integrations/gsc';

export const gscRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// State token: encodes siteId + per-attempt nonce, signed with MAGIC_LINK_SECRET
// so we can verify on callback without storing anything in KV.
type StatePayload = { siteId: string; userId: string; nonce: string };

function redirectUri(reqUrl: string): string {
  // The callback lives on this worker (api host), not the SPA (RECTO_PUBLIC_ORIGIN).
  // Derive from the inbound request URL so prod/preview/dev each get the right host.
  const u = new URL(reqUrl);
  return `${u.protocol}//${u.host}/api/oauth/gsc/callback`;
}

async function packState(env: Env, payload: StatePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = await sign(b64, env.MAGIC_LINK_SECRET);
  return `${b64}.${sig}`;
}

async function unpackState(env: Env, state: string): Promise<StatePayload | null> {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const b64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!(await verify(b64, sig, env.MAGIC_LINK_SECRET))) return null;
  try {
    const json = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(json) as StatePayload;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/gsc/connect?siteId=...   (auth required, kicks off OAuth)
// ────────────────────────────────────────────────────────────────────────────

gscRouter.get('/connect', requireSession, async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'missing_site_id' }, 400);
  const userId = c.get('userId');

  // Confirm the site belongs to the user before redirecting to Google.
  const row = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const state = await packState(c.env, { siteId, userId, nonce: randomToken(8) });
  const url = authorizeUrl({
    clientId: c.env.GSC_CLIENT_ID,
    redirectUri: redirectUri(c.req.url),
    state,
  });
  return c.redirect(url, 302);
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/oauth/gsc/callback?code=...&state=...
// Mounted under /api/oauth/gsc by the app entry; not under /api/gsc.
// ────────────────────────────────────────────────────────────────────────────

export const gscOauthRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

gscOauthRouter.get('/callback', requireSession, async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  const error = c.req.query('error');

  if (error) return c.redirect(`${c.env.RECTO_PUBLIC_ORIGIN}/app/setup-summary.html?gsc_error=${error}`, 302);
  if (!code || !stateRaw) return c.json({ error: 'invalid_callback' }, 400);

  const state = await unpackState(c.env, stateRaw);
  if (!state) return c.json({ error: 'state_invalid' }, 400);

  // Belt-and-suspenders: ensure the cookie user matches the state.
  if (state.userId !== c.get('userId')) return c.json({ error: 'state_user_mismatch' }, 401);

  // Re-confirm site ownership in case it was deleted while user was in Google's flow.
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(state.siteId, state.userId)
    .first<{ id: string }>();
  if (!site) return c.json({ error: 'not_found' }, 404);

  let tokens;
  try {
    tokens = await exchangeCode({
      clientId: c.env.GSC_CLIENT_ID,
      clientSecret: c.env.GSC_CLIENT_SECRET,
      redirectUri: redirectUri(c.req.url),
      code,
    });
  } catch (e) {
    return c.json({ error: 'gsc_exchange_failed', detail: (e as Error).message.slice(0, 200) }, 502);
  }

  if (!tokens.refresh_token) {
    return c.json({ error: 'no_refresh_token' }, 502);
  }

  const encrypted = await encrypt(tokens.refresh_token, c.env.RECTO_KEK);
  await c.env.DB.prepare('UPDATE sites SET gsc_refresh_token = ? WHERE id = ?')
    .bind(encrypted, state.siteId)
    .run();

  // Route to property picker.
  return c.redirect(
    `${c.env.RECTO_PUBLIC_ORIGIN}/app/setup-summary.html?siteId=${state.siteId}&gsc=connected`,
    302
  );
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/gsc/properties?siteId=...
// Lists verified properties so the user can pick which one maps to this site.
// ────────────────────────────────────────────────────────────────────────────

gscRouter.get('/properties', requireSession, async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'missing_site_id' }, 400);
  const userId = c.get('userId');

  const row = await c.env.DB.prepare(
    'SELECT gsc_refresh_token FROM sites WHERE id = ? AND user_id = ?'
  )
    .bind(siteId, userId)
    .first<{ gsc_refresh_token: Uint8Array | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!row.gsc_refresh_token) return c.json({ error: 'gsc_not_connected' }, 400);

  const refreshToken = await decrypt(row.gsc_refresh_token, c.env.RECTO_KEK);

  // Exchange refresh → access (one-shot, ~5 ms).
  const { refreshAccessToken } = await import('../integrations/gsc');
  let tokens;
  try {
    tokens = await refreshAccessToken({
      clientId: c.env.GSC_CLIENT_ID,
      clientSecret: c.env.GSC_CLIENT_SECRET,
      refreshToken,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'gsc_reauth_required') {
      // The user revoked at myaccount.google.com — clear the token and surface as reauth.
      await c.env.DB.prepare('UPDATE sites SET gsc_refresh_token = NULL WHERE id = ?')
        .bind(siteId)
        .run();
      return c.json({ error: 'gsc_reauth_required' }, 409);
    }
    return c.json({ error: 'gsc_refresh_failed', detail: msg.slice(0, 200) }, 502);
  }

  const properties = await listProperties(tokens.access_token);
  return c.json({ properties });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/gsc/select  { siteId, property }
// Stores the chosen GSC property identifier; queues backfill (D2.3).
// ────────────────────────────────────────────────────────────────────────────

const SelectBody = z.object({
  siteId: z.string().min(1),
  property: z.string().min(1),
});

gscRouter.post('/select', requireSession, async (c) => {
  const parsed = SelectBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { siteId, property } = parsed.data;
  const userId = c.get('userId');

  const own = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ? AND user_id = ?')
    .bind(siteId, userId)
    .first<{ id: string }>();
  if (!own) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.prepare('UPDATE sites SET gsc_property = ? WHERE id = ?')
    .bind(property, siteId)
    .run();

  // Enqueue 90-day backfill. The consumer (D2.3) fans out one message per day.
  await c.env.Q_GSC_BACKFILL.send({ siteId, kind: 'backfill', daysBack: 90 });

  return c.json({ ok: true });
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/gsc/disconnect  { siteId }
// Revokes locally (the token at Google stays until user clicks revoke there).
// ────────────────────────────────────────────────────────────────────────────

gscRouter.delete('/disconnect', requireSession, async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'missing_site_id' }, 400);
  const userId = c.get('userId');

  const result = await c.env.DB.prepare(
    'UPDATE sites SET gsc_refresh_token = NULL, gsc_property = NULL WHERE id = ? AND user_id = ?'
  )
    .bind(siteId, userId)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export type GscPropertyAlias = GscProperty;
