// Magic-link auth — request and redeem.
// Token lifetime: 30 min. One-shot use enforced by `used_at`.

import { hashToken, randomToken } from '../lib/crypto';
import { ulid } from '../lib/ids';
import { send } from '../integrations/mail';
import type { Env } from '../env';

const TOKEN_TTL_MS = 30 * 60 * 1000;

export type MagicRequestResult = {
  emailed: boolean;
  devToken?: string; // only populated in dev so wrangler tail can show the link
};

// The magic-link URL must point at the API callback (api.rectoapp.com), NOT
// the SPA (rectoapp.com/app/auth.html). The callback is what reads the token,
// creates the session, sets the cookie, and redirects to the workbench. We
// derive the API host from the incoming request so this works in prod, preview,
// and dev without environment-specific config.
export async function requestMagicLink(env: Env, email: string, apiBase: string): Promise<MagicRequestResult> {
  const normalized = email.trim().toLowerCase();

  // Upsert user. Email is the only stable identity.
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(normalized)
    .first<{ id: string }>();

  let userId: string;
  if (existing) {
    userId = existing.id;
  } else {
    userId = ulid();
    await env.DB.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    )
      .bind(userId, normalized, Date.now())
      .run();
  }

  // Generate token, store hash, "send" email.
  const token = randomToken(32);
  const hash = await hashToken(token);
  const expiresAt = Date.now() + TOKEN_TTL_MS;

  await env.DB.prepare(
    'INSERT INTO magic_tokens (hash, user_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(hash, userId, expiresAt)
    .run();

  const url = `${apiBase.replace(/\/$/, '')}/api/auth/callback?token=${token}`;
  await send(env, {
    to: normalized,
    subject: 'recto is ready.',
    body:
      'Use this link in the next 30 minutes:\n  ' + url + '\n\nIf you did not ask for this, ignore the email. Nothing changes.\n\n— recto',
  });

  return {
    emailed: true,
    ...(env.RECTO_ENV === 'dev' ? { devToken: token } : {}),
  };
}

export async function redeemMagicLink(env: Env, token: string): Promise<{ userId: string } | null> {
  const hash = await hashToken(token);
  const row = await env.DB.prepare(
    'SELECT user_id, expires_at, used_at FROM magic_tokens WHERE hash = ?'
  )
    .bind(hash)
    .first<{ user_id: string; expires_at: number; used_at: number | null }>();

  if (!row) return null;
  if (row.used_at !== null) return null;
  if (row.expires_at < Date.now()) return null;

  await env.DB.prepare('UPDATE magic_tokens SET used_at = ? WHERE hash = ?')
    .bind(Date.now(), hash)
    .run();

  return { userId: row.user_id };
}
