// /api/users/me — profile and BYOK key management.
//
// GET  /api/users/me              → email, name, onboarded, byok presence, digest opt-in.
// PUT  /api/users/me              → update byok_openai_key, byok_anthropic_key, digest_opt_in.
// POST /api/users/onboard         → first-time onboarding: capture name (and optional pending website).
// DEL  /api/users/me/byok/:vendor → remove a stored key.
//
// Keys are AES-256-GCM encrypted with RECTO_KEK. We only persist the encrypted
// blob; the raw key is held in memory just long enough to encrypt.

import { Hono } from 'hono';
import type { Env } from '../env';
import { requireSession, type AuthVars } from '../auth/middleware';
import { encrypt } from '../lib/crypto';

export const usersRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();
usersRouter.use('*', requireSession);

usersRouter.get('/me', async (c) => {
  const userId = c.get('userId');
  const u = await c.env.DB.prepare(
    `SELECT id, email, name, created_at, last_login_at, onboarded_at,
            byok_openai_key, byok_anthropic_key, digest_opt_in
       FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      name: string | null;
      created_at: number;
      last_login_at: number | null;
      onboarded_at: number | null;
      byok_openai_key: ArrayBuffer | null;
      byok_anthropic_key: ArrayBuffer | null;
      digest_opt_in: number;
    }>();
  if (!u) return c.json({ error: 'not_found' }, 404);

  const siteCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?')
    .bind(userId)
    .first<{ n: number }>();

  return c.json({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    onboarded: u.onboarded_at != null,
    onboardedAt: u.onboarded_at,
    sitesConnected: siteCount?.n ?? 0,
    digestOptIn: !!u.digest_opt_in,
    byok: {
      openai: !!u.byok_openai_key,
      anthropic: !!u.byok_anthropic_key,
    },
  });
});

// First-time onboarding. Captures name (and an optional pending website URL the
// user wants to connect next) and stamps onboarded_at. Idempotent: a re-submit
// just overwrites the name. Returns the website URL so the client can fast-track
// the connect flow with it pre-filled.
type OnboardBody = { name?: string; website?: string };
usersRouter.post('/onboard', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json().catch(() => ({}))) as OnboardBody;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) return c.json({ error: 'invalid_name' }, 400);

  let website: string | null = null;
  if (typeof body.website === 'string' && body.website.trim()) {
    const raw = body.website.trim();
    // Reject any explicit non-http(s) scheme up-front. Otherwise our "prepend
    // https://" shortcut creates parseable garbage like `https://ftp://...`
    // whose URL().protocol still resolves to https.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
      return c.json({ error: 'invalid_website' }, 400);
    }
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return c.json({ error: 'invalid_website' }, 400);
      }
      if (!parsed.hostname || !/[a-z]/i.test(parsed.hostname)) {
        return c.json({ error: 'invalid_website' }, 400);
      }
      website = parsed.origin;
    } catch {
      return c.json({ error: 'invalid_website' }, 400);
    }
  }

  await c.env.DB.prepare(
    `UPDATE users SET name = ?, onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?`
  )
    .bind(name, Date.now(), userId)
    .run();

  return c.json({ ok: true, name, website });
});

type PutBody = {
  byokOpenaiKey?: string | null;
  byokAnthropicKey?: string | null;
  digestOptIn?: boolean;
};

usersRouter.put('/me', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json().catch(() => ({}))) as PutBody;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.byokOpenaiKey === null) {
    sets.push('byok_openai_key = NULL');
  } else if (typeof body.byokOpenaiKey === 'string' && body.byokOpenaiKey.trim()) {
    const k = body.byokOpenaiKey.trim();
    if (!k.startsWith('sk-') || k.length < 20 || k.length > 200) {
      return c.json({ error: 'invalid_openai_key' }, 400);
    }
    const enc = await encrypt(k, c.env.RECTO_KEK);
    sets.push('byok_openai_key = ?');
    params.push(enc);
  }

  if (body.byokAnthropicKey === null) {
    sets.push('byok_anthropic_key = NULL');
  } else if (typeof body.byokAnthropicKey === 'string' && body.byokAnthropicKey.trim()) {
    const k = body.byokAnthropicKey.trim();
    if (!k.startsWith('sk-ant-') || k.length < 20 || k.length > 200) {
      return c.json({ error: 'invalid_anthropic_key' }, 400);
    }
    const enc = await encrypt(k, c.env.RECTO_KEK);
    sets.push('byok_anthropic_key = ?');
    params.push(enc);
  }

  if (typeof body.digestOptIn === 'boolean') {
    sets.push('digest_opt_in = ?');
    params.push(body.digestOptIn ? 1 : 0);
  }

  if (sets.length === 0) return c.json({ error: 'nothing_to_update' }, 400);

  params.push(userId);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  return c.json({ ok: true });
});

usersRouter.delete('/me/byok/:vendor', async (c) => {
  const userId = c.get('userId');
  const vendor = c.req.param('vendor');
  const col = vendor === 'openai' ? 'byok_openai_key' : vendor === 'anthropic' ? 'byok_anthropic_key' : null;
  if (!col) return c.json({ error: 'invalid_vendor' }, 400);
  await c.env.DB.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).bind(userId).run();
  return c.json({ ok: true });
});
