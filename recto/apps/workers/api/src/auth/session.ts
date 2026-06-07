// Session lifecycle. Signed cookie format: `<sessionId>.<hmac>`.
// Server-side state lives in D1 sessions table; the HMAC stops cookie tampering.

import { randomToken, sign, verify } from '../lib/crypto';
import { ulid } from '../lib/ids';
import type { Env } from '../env';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = 'recto_session';

export async function createSession(
  env: Env,
  userId: string,
  ipHash?: string,
  uaHash?: string
): Promise<{ id: string; cookie: string; expiresAt: number }> {
  const id = ulid() + randomToken(16); // sortable prefix + entropy
  const expiresAt = Date.now() + SESSION_TTL_MS;

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, ip_hash, ua_hash) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, userId, expiresAt, ipHash ?? null, uaHash ?? null)
    .run();

  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(Date.now(), userId)
    .run();

  const sig = await sign(id, env.MAGIC_LINK_SECRET);
  // SameSite policy depends on whether the SPA and API share a parent domain:
  //   - recto-ui.pages.dev + recto-api.workers.dev → cross-site → None
  //   - recto.so + api.recto.so → same-site → Lax
  // RECTO_PUBLIC_ORIGIN tells us where the SPA lives; if its eTLD+1 differs
  // from the API host we serve None; otherwise Lax keeps CSRF surface tight.
  const sameSite = sessionSameSite(env);
  const cookie = `${SESSION_COOKIE}=${id}.${sig}; Path=/; HttpOnly; Secure; SameSite=${sameSite}${cookieDomain(env)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return { id, cookie, expiresAt };
}

// Cookie Domain. In prod the API (api.rectoapp.com) sets the session cookie but
// the SPA lives on rectoapp.com — without an explicit parent Domain the cookie
// is HOST-ONLY (api.rectoapp.com) and does not travel to the apex/www, so a user
// who returns to rectoapp.com (e.g. from an email link) gets signed out. Scoping
// to `.rectoapp.com` shares one session across apex + www + api. (Caught
// 2026-06-06.) For pages.dev/workers.dev/dev the SPA and API are different
// eTLD+1, so no shared Domain is possible — stay host-only there.
function cookieDomain(env: Env): string {
  try {
    const origin = env.RECTO_PUBLIC_ORIGIN || '';
    if (!origin || env.RECTO_ENV === 'dev') return '';
    const host = new URL(origin).hostname;
    if (host.endsWith('.pages.dev') || host.endsWith('.workers.dev')) return '';
    if (host === 'localhost' || /^\d/.test(host)) return '';
    const parent = host.replace(/^www\./, '');
    return `; Domain=.${parent}`;
  } catch {
    return '';
  }
}

export async function loadSession(
  env: Env,
  cookieHeader: string | null
): Promise<{ userId: string; sessionId: string } | null> {
  if (!cookieHeader) return null;
  const raw = parseCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return null;

  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const sessionId = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);

  const ok = await verify(sessionId, sig, env.MAGIC_LINK_SECRET);
  if (!ok) return null;

  const row = await env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE id = ?'
  )
    .bind(sessionId)
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  return { userId: row.user_id, sessionId };
}

export async function destroySession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export function clearedCookie(env?: Env): string {
  const sameSite = env ? sessionSameSite(env) : 'Lax';
  // Must mirror the Domain used when setting the cookie, or the browser keeps
  // the parent-domain cookie and logout doesn't actually sign the user out.
  const domain = env ? cookieDomain(env) : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=${sameSite}${domain}; Max-Age=0`;
}

function sessionSameSite(env: Env): 'None' | 'Lax' {
  try {
    const origin = env.RECTO_PUBLIC_ORIGIN || '';
    if (!origin) return 'Lax';
    // workers.dev and pages.dev are different eTLD+1 (PSL-listed). Any time
    // RECTO_PUBLIC_ORIGIN host ≠ the API host (this Worker), the browser
    // treats the fetch as cross-site, so we need None to send cookies.
    const u = new URL(origin);
    const isCrossSite =
      u.hostname.endsWith('.pages.dev') ||
      u.hostname.endsWith('.workers.dev') ||
      (env.RECTO_ENV === 'dev'); // local: SPA on :8765, API on :8787 — cross-site
    return isCrossSite ? 'None' : 'Lax';
  } catch {
    return 'Lax';
  }
}

function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    // Split on the FIRST '=' only. `split('=')` + destructure dropped everything
    // after the first '=' in the VALUE — fine for today's tokens (b64url, no
    // padding) but a silent landmine: switch the session/sig encoding to anything
    // containing '=' (standard base64 padding, a JWT) and every login breaks with
    // no error. A cookie value legitimately may contain '='. (Hardened 2026-06-07.)
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (k === name && v) return v;
  }
  return null;
}
