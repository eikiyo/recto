// MailChannels transactional email. Free from Cloudflare Workers when the
// sending domain has a TXT record:
//   _mailchannels.recto.so → "v=mc1 cfid=<workers-account-id>"
//
// Two public entry points:
//   - send(env, MailMessage): direct send used by magic-link delivery (no queue).
//   - handleEmailBatch(batch, env): q-email consumer that templates by name
//     and renders + sends.

import type { Env } from '../env';
import { renderWelcome } from '../emails/welcome';
import { renderCrawlComplete } from '../emails/crawl-complete';
import { renderWeeklyDigest } from '../emails/weekly-digest';
import { renderMagicLink } from '../emails/magic-link';
import { renderTierUpgrade } from '../emails/tier-upgrade';
import { renderByokThreshold } from '../emails/byok-threshold';

const FROM = 'recto <hello@rectoapp.com>';
const REPLY_TO = 'hello@rectoapp.com';

export type MailMessage = {
  to: string;
  subject: string;
  body: string;          // plain text per BRAND-VOICE §8
  html?: string;
};

export type EmailMsg = {
  template: string;
  userId: string;
  data: Record<string, unknown>;
};

export async function send(env: Env, msg: MailMessage): Promise<void> {
  if (env.RECTO_ENV === 'dev') {
    // Dev mode: keep the magic link visible in `wrangler tail`. No outbound.
    console.log('[mail dev]', { to: msg.to, subject: msg.subject });
    console.log(msg.body);
    return;
  }
  const html = msg.html ?? plainToHtml(msg.body);
  const result = await dispatch(env, msg.to, msg.subject, msg.body, html);
  if (!result.ok) {
    console.warn('[ADMIN-DELIVERY] mail send failed — operator must deliver manually', {
      to: msg.to,
      subject: msg.subject,
      body: msg.body,
      errors: result.errors,
    });
  }
}

// Walk the configured transports in order: Emailit → Resend → MailChannels.
// Return on the first success. Each failure is logged so a partial-fallback
// (e.g., Emailit's domain rejected but Resend delivered) leaves enough
// breadcrumbs for the operator to know which provider to fix. Auth flow never
// 5xx's because of an email provider hiccup — final fall-through ends up in
// the ADMIN-DELIVERY log.
async function dispatch(
  env: Env,
  to: string,
  subject: string,
  text: string,
  html: string
): Promise<{ ok: boolean; provider?: string; errors: Array<{ provider: string; error: string }> }> {
  const errors: Array<{ provider: string; error: string }> = [];

  if (env.EMAILIT_API_KEY) {
    try {
      await postEmailit(env.EMAILIT_API_KEY, to, subject, text, html);
      return { ok: true, provider: 'emailit', errors };
    } catch (e) {
      const err = (e as Error).message;
      errors.push({ provider: 'emailit', error: err });
      console.warn('[mail] emailit failed, trying next transport', { to, error: err });
    }
  }
  if (env.RESEND_API_KEY) {
    try {
      await postResend(env.RESEND_API_KEY, to, subject, text, html);
      return { ok: true, provider: 'resend', errors };
    } catch (e) {
      const err = (e as Error).message;
      errors.push({ provider: 'resend', error: err });
      console.warn('[mail] resend failed, trying next transport', { to, error: err });
    }
  }
  try {
    await postMailChannels(to, subject, text, html);
    return { ok: true, provider: 'mailchannels', errors };
  } catch (e) {
    errors.push({ provider: 'mailchannels', error: (e as Error).message });
  }
  return { ok: false, errors };
}

async function postEmailit(apiKey: string, to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetch('https://api.emailit.com/v1/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to,
      subject,
      text,
      html,
      reply_to: REPLY_TO,
    }),
  });
  if (!res.ok) throw new Error(`emailit_${res.status}_${(await res.text()).slice(0, 200)}`);
}

async function postResend(apiKey: string, to: string, subject: string, text: string, html: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      text,
      html,
      reply_to: REPLY_TO,
    }),
  });
  if (!res.ok) throw new Error(`resend_${res.status}_${(await res.text()).slice(0, 200)}`);
}

export async function handleEmailBatch(batch: MessageBatch<EmailMsg>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await sendTemplated(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error('email error', { template: msg.body.template, error: (e as Error).message });
      msg.retry({ delaySeconds: 60 });
    }
  }
}

async function sendTemplated(env: Env, body: EmailMsg): Promise<void> {
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(body.userId)
    .first<{ email: string }>();
  if (!user) {
    console.warn('email skip — user not found', { userId: body.userId });
    return;
  }
  const rendered = render(body.template, body.data);
  if (!rendered) {
    console.warn('email skip — unknown template', { template: body.template });
    return;
  }
  if (env.RECTO_ENV === 'dev') {
    console.log('[mail dev]', { to: user.email, template: body.template, subject: rendered.subject });
    console.log(rendered.text);
    return;
  }
  // Same transport order as send(): Emailit → Resend → MailChannels.
  // Throws on full chain failure so q-email retries the message (delaySeconds:60
  // in handleEmailBatch) — a transient provider blip self-heals on the next pass.
  const result = await dispatch(env, user.email, rendered.subject, rendered.text, rendered.html);
  if (!result.ok) {
    throw new Error('all mail transports failed: ' + result.errors.map((x) => x.provider + '=' + x.error).join(' | '));
  }
}

async function postMailChannels(to: string, subject: string, text: string, html: string): Promise<void> {
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: parseAddr(FROM),
    reply_to: { email: REPLY_TO },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
  };
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`mailchannels_${res.status}`);
  }
}

function render(template: string, data: Record<string, unknown>): { subject: string; text: string; html: string } | null {
  switch (template) {
    case 'welcome':            return renderWelcome(data);
    case 'crawl-complete':     return renderCrawlComplete(data);
    case 'weekly-digest':      return renderWeeklyDigest(data);
    case 'magic-link':         return renderMagicLink(data);
    case 'tier-upgrade':       return renderTierUpgrade(data);
    case 'byok-threshold':     return renderByokThreshold(data);
    default:                   return null;
  }
}

function parseAddr(s: string): { name?: string; email: string } {
  const m = /^(.*?)<([^>]+)>$/.exec(s);
  if (!m) return { email: s };
  const name = m[1]?.trim();
  const email = (m[2] ?? '').trim();
  return name ? { name, email } : { email };
}

function plainToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="font:14px/1.5 -apple-system,system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">${escaped}</body></html>`;
}
