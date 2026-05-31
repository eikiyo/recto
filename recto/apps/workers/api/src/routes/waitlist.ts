// POST /api/waitlist — accept name + email, dedupe by email, notify operator.
//
// Pre-user endpoint: no session, no user row. Anti-spam via:
//   - KV rate limit, 5 / IP / hour
//   - INSERT OR IGNORE on email-unique (duplicate returns 200 alreadySignedUp:true)
//   - send() operator notification skipped in dev
//
// On full mail-transport failure we still return ok:true — the row is in
// the DB; missing the notification is a soft failure we surface in logs.

import { Hono } from 'hono';
import type { Env } from '../env';
import { ulid } from '../lib/ids';
import { send } from '../integrations/mail';

const OPERATOR_EMAIL = 'syedmosayebalam@gmail.com';
const NAME_MAX = 120;
const EMAIL_MAX = 254;          // RFC 5321
const SOURCE_MAX = 64;
const RATE_LIMIT_PER_HOUR = 5;

// Conservative email shape check. Real validation happens at delivery.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const waitlistRouter = new Hono<{ Bindings: Env }>();

waitlistRouter.post('/', async (c) => {
  // Rate limit — skip in dev so Playwright doesn't trip it.
  if (c.env.RECTO_ENV !== 'dev') {
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for') ?? 'local';
    const key = `rl:waitlist:${ip}`;
    const raw = await c.env.KV.get(key);
    const count = raw ? Number(raw) : 0;
    if (count >= RATE_LIMIT_PER_HOUR) {
      return c.json({ error: 'rate_limited', message: 'Too many signups from this network. Try again later.' }, 429);
    }
    await c.env.KV.put(key, String(count + 1), { expirationTtl: 3600 });
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const source = typeof b.source === 'string' ? b.source.trim().slice(0, SOURCE_MAX) : null;

  if (!name || name.length > NAME_MAX) {
    return c.json({ error: 'invalid_name' }, 400);
  }
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }

  const id = ulid();
  const now = Date.now();
  const ip = c.req.header('CF-Connecting-IP') ?? null;
  const ua = c.req.header('User-Agent')?.slice(0, 240) ?? null;

  // INSERT OR IGNORE so duplicate emails are a no-op, not an error. We then
  // check `changes` (D1 meta) to know whether the row was new.
  const result = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO waitlist (id, email, name, source, ip, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, email, name, source, ip, ua, now)
    .run();

  const inserted = (result.meta?.changes ?? 0) > 0;

  // Operator notification — only on new rows, only outside dev. A transport
  // failure is logged inside send() and we still return ok to the caller.
  if (inserted && c.env.RECTO_ENV !== 'dev') {
    const subject = `[waitlist] ${name} <${email}>`;
    const lines = [
      `Name:   ${name}`,
      `Email:  ${email}`,
      `Source: ${source ?? '(none)'}`,
      `IP:     ${ip ?? '(none)'}`,
      `When:   ${new Date(now).toISOString()}`,
    ];
    try {
      await send(c.env, { to: OPERATOR_EMAIL, subject, body: lines.join('\n') });
    } catch (e) {
      console.warn('waitlist notify failed', { error: (e as Error).message });
    }
  }

  return c.json({ ok: true, alreadySignedUp: !inserted });
});
