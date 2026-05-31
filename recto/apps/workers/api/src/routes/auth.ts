import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { requestMagicLink, redeemMagicLink } from '../auth/magic';
import { createSession, destroySession, clearedCookie } from '../auth/session';
import { hashToken } from '../lib/crypto';
import { requireSession, type AuthVars } from '../auth/middleware';

export const authRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

const EmailBody = z.object({ email: z.string().email() });

authRouter.post('/magic', async (c) => {
  const parsed = EmailBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_email' }, 400);
  // Derive the API base from the inbound request so the email link returns to
  // the same host that issued the token (api.rectoapp.com in prod).
  const u = new URL(c.req.url);
  const apiBase = `${u.protocol}//${u.host}`;
  const result = await requestMagicLink(c.env, parsed.data.email, apiBase);
  return c.json(result);
});

authRouter.get('/callback', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'missing_token' }, 400);
  const redeemed = await redeemMagicLink(c.env, token);
  if (!redeemed) return c.json({ error: 'invalid_or_expired_token' }, 401);

  const ipHash = await hashToken(c.req.header('CF-Connecting-IP') ?? 'unknown');
  const uaHash = await hashToken(c.req.header('User-Agent') ?? 'unknown');
  const { cookie } = await createSession(c.env, redeemed.userId, ipHash, uaHash);

  c.header('Set-Cookie', cookie);
  // For now redirect to the workbench. The static UI handles the rest.
  return c.redirect(`${c.env.RECTO_PUBLIC_ORIGIN}/app/workbench.html`, 302);
});

authRouter.post('/logout', requireSession, async (c) => {
  await destroySession(c.env, c.get('sessionId'));
  c.header('Set-Cookie', clearedCookie(c.env));
  return c.json({ ok: true });
});

authRouter.get('/me', requireSession, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id, email, anchor_credits, last_login_at, digest_opt_in FROM users WHERE id = ?'
  )
    .bind(c.get('userId'))
    .first<{
      id: string;
      email: string;
      anchor_credits: number;
      last_login_at: number | null;
      digest_opt_in: number;
    }>();
  if (!user) return c.json({ error: 'user_gone' }, 404);
  return c.json({
    id: user.id,
    email: user.email,
    anchorCredits: user.anchor_credits,
    lastLoginAt: user.last_login_at,
    digestOptIn: user.digest_opt_in === 1,
  });
});
