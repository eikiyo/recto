// AppSumo Licensing API v2 webhook handler.
//
// Pricing model (locked 2026-05-29): flat $39/code. 1 code = 1 site + 100
// anchor credits per calendar month. Stacking codes adds sites and grows the
// monthly credit pool linearly. Credits do NOT carry month-to-month — the
// monthly cron resets every user to `non_refunded_code_count * 100`.
//
// Events:
//   activate — first redemption. Create user if missing, insert license row,
//              top up credits NOW so the user has +100 for the rest of this
//              month (no proration; credits don't pile up at month-end).
//   refund   — 60-day window. Mark refunded_at. Cap credits to the new lower
//              ceiling immediately so the user can't burn a refunded code's
//              allowance after the refund event.
//   upgrade  — additional code stacked onto an existing user. Same as activate
//              for credit + site accounting; license row tracks the link.
//
// HMAC-SHA-256 signature in `x-appsumo-signature` verified against
// APPSUMO_WEBHOOK_SECRET. Replay protection via event_id in KV.

import { Hono } from 'hono';
import type { Env } from '../env';
import { sign as hmacSign } from '../lib/crypto';
import { ulid } from '../lib/ids';
import { ANCHOR_CREDITS_PER_CODE_MONTHLY } from '@recto/shared';

export const appsumoRouter = new Hono<{ Bindings: Env }>();

const REPLAY_TTL_S = 7 * 24 * 60 * 60;

appsumoRouter.post('/webhook', async (c) => {
  const sigHeader = c.req.header('x-appsumo-signature');
  if (!sigHeader) return c.json({ error: 'missing_signature' }, 401);

  const raw = await c.req.text();
  const expected = await hmacSign(raw, c.env.APPSUMO_WEBHOOK_SECRET);
  if (!timingSafeEqual(sigHeader, expected)) {
    return c.json({ error: 'bad_signature' }, 401);
  }

  let body: AppSumoEvent;
  try {
    body = JSON.parse(raw) as AppSumoEvent;
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }

  // Replay protection.
  const replayKey = `appsumo:evt:${body.event_id}`;
  if (await c.env.KV.get(replayKey)) {
    return c.json({ ok: true, deduped: true });
  }
  await c.env.KV.put(replayKey, '1', { expirationTtl: REPLAY_TTL_S });

  switch (body.event) {
    case 'activate':
      return c.json(await handleActivate(c.env, body));
    case 'refund':
      return c.json(await handleRefund(c.env, body));
    case 'upgrade':
      return c.json(await handleUpgrade(c.env, body));
    default:
      return c.json({ error: 'unknown_event' }, 400);
  }
});

type AppSumoEvent = {
  event: 'activate' | 'refund' | 'upgrade';
  event_id: string;
  email: string;
  appsumo_code: string;
  // Legacy field, kept in payload but no longer drives behavior. All codes are
  // equal: $39, +1 site, +100 credits/month. We persist as 1 so historical
  // queries against the licenses table stay sensible.
  tier?: number;
  stacked_into?: string;
};

async function handleActivate(env: Env, ev: AppSumoEvent): Promise<{ ok: true; userId: string; licenseId: string; codes: number }> {
  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ev.email).first<{ id: string }>();
  if (!user) {
    const uid = ulid();
    await env.DB.prepare(
      'INSERT INTO users (id, email, created_at, digest_opt_in) VALUES (?, ?, ?, 1)'
    )
      .bind(uid, ev.email, Date.now())
      .run();
    user = { id: uid };
  }

  const lid = ulid();
  await env.DB.prepare(
    `INSERT INTO licenses (id, user_id, appsumo_code, tier, redeemed_at)
     VALUES (?, ?, ?, 1, ?)`
  )
    .bind(lid, user.id, ev.appsumo_code, Date.now())
    .run();

  // Mid-month top-up: a fresh code adds +100 to the active pool immediately so
  // the user gets value the same day they redeem. The monthly cron will overwrite
  // to the canonical ceiling on the 1st (no carry-over by design).
  await env.DB.prepare(
    'UPDATE users SET anchor_credits = anchor_credits + ? WHERE id = ?'
  )
    .bind(ANCHOR_CREDITS_PER_CODE_MONTHLY, user.id)
    .run();

  const codes = await countActiveCodes(env, user.id);
  await env.Q_EMAIL.send({
    template: 'welcome',
    userId: user.id,
    data: { codes, monthlyCredits: codes * ANCHOR_CREDITS_PER_CODE_MONTHLY },
  });

  return { ok: true, userId: user.id, licenseId: lid, codes };
}

async function handleRefund(env: Env, ev: AppSumoEvent): Promise<{ ok: true; refunded: boolean; codes: number }> {
  const lic = await env.DB.prepare(
    'SELECT id, user_id FROM licenses WHERE appsumo_code = ?'
  )
    .bind(ev.appsumo_code)
    .first<{ id: string; user_id: string }>();
  if (!lic) return { ok: true, refunded: false, codes: 0 };

  await env.DB.prepare('UPDATE licenses SET refunded_at = ? WHERE id = ?')
    .bind(Date.now(), lic.id)
    .run();

  // Cap the user's current pool to the new ceiling. If they had unused credits
  // above the new cap, those go away — refund must not leave a balance the user
  // could still spend on the refunded code's allowance.
  const codes = await countActiveCodes(env, lic.user_id);
  const newCeiling = codes * ANCHOR_CREDITS_PER_CODE_MONTHLY;
  await env.DB.prepare('UPDATE users SET anchor_credits = MIN(anchor_credits, ?) WHERE id = ?')
    .bind(newCeiling, lic.user_id)
    .run();
  return { ok: true, refunded: true, codes };
}

async function handleUpgrade(env: Env, ev: AppSumoEvent): Promise<{ ok: true; upgraded: boolean; codes: number }> {
  const existing = ev.stacked_into
    ? await env.DB.prepare('SELECT id, user_id FROM licenses WHERE id = ?').bind(ev.stacked_into).first<{ id: string; user_id: string }>()
    : await env.DB.prepare('SELECT id, user_id FROM licenses WHERE appsumo_code = ?').bind(ev.appsumo_code).first<{ id: string; user_id: string }>();
  if (!existing) return { ok: true, upgraded: false, codes: 0 };

  // Stacking is functionally identical to activate now — same +1 site, +100
  // credits/month. We persist a separate license row referencing the original
  // so the audit trail shows the chain.
  const lid = ulid();
  await env.DB.prepare(
    `INSERT INTO licenses (id, user_id, appsumo_code, tier, redeemed_at, stacked_into)
     VALUES (?, ?, ?, 1, ?, ?)`
  )
    .bind(lid, existing.user_id, ev.appsumo_code, Date.now(), existing.id)
    .run();
  await env.DB.prepare(
    'UPDATE users SET anchor_credits = anchor_credits + ? WHERE id = ?'
  )
    .bind(ANCHOR_CREDITS_PER_CODE_MONTHLY, existing.user_id)
    .run();
  const codes = await countActiveCodes(env, existing.user_id);
  await env.Q_EMAIL.send({
    template: 'tier-upgrade',
    userId: existing.user_id,
    data: { codes, monthlyCredits: codes * ANCHOR_CREDITS_PER_CODE_MONTHLY },
  });
  return { ok: true, upgraded: true, codes };
}

async function countActiveCodes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM licenses WHERE user_id = ? AND refunded_at IS NULL'
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
