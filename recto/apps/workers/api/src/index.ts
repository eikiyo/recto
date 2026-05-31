import { Hono } from 'hono';
import type { Env, GscBackfillJob } from './env';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { sitesRouter } from './routes/sites';
import { workbenchRouter } from './routes/workbench';
import { orphansRouter } from './routes/orphans';
import { gscRouter, gscOauthRouter } from './routes/gsc';
import { handleScheduled } from './crons';
import { handleGscBackfillBatch } from './jobs/gsc-backfill';
import { handleCrawlBatch } from './jobs/crawl';
import { handleEmbedBatch } from './jobs/embed';
import { handlePushBatch } from './jobs/push';
import { handleVerifyBatch } from './jobs/verify';
import { handleEmailBatch, type EmailMsg } from './integrations/mail';
import { pushesRouter } from './routes/pushes';
import { candidatesRouter, regenerateAnchorRouter } from './routes/candidates';
import { appsumoRouter } from './routes/appsumo';
import { errorsRouter } from './routes/errors';
import { usersRouter } from './routes/users';
import { waitlistRouter } from './routes/waitlist';

const app = new Hono<{ Bindings: Env }>();

// Cross-route headers + minimal logging. No PII surfaced.
// CORS: same-origin in prod (recto.so + api.recto.so share a base domain
// so cookies cross subdomains); explicit cross-origin allow in dev so the
// SPA on :8765 can talk to the API on :8787.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  'https://rectoapp.com',
  'https://www.rectoapp.com',
]);
function originAllowed(o: string | undefined): boolean {
  if (!o) return false;
  if (ALLOWED_ORIGINS.has(o)) return true;
  // Pages preview deploys live at *.pages.dev — allow any subdomain of the
  // recto Pages project so previews can talk to api.rectoapp.com / workers.dev.
  return /^https:\/\/[a-z0-9-]+\.recto-ui\.pages\.dev$/.test(o)
    || o === 'https://recto-ui.pages.dev';
}
app.use('*', async (c, next) => {
  c.header('X-Recto-Env', c.env.RECTO_ENV);

  // Security headers — applied to every response. The API never serves HTML
  // to a browser tab, but defence in depth is cheap.
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'interest-cohort=()');
  if (c.env.RECTO_ENV !== 'dev') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const origin = c.req.header('origin');
  if (origin && originAllowed(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-Appsumo-Signature');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

// Rate limit /api/auth/magic — 10 requests per IP per 10 minutes in prod.
// In dev the limit is disabled so parallel Playwright workers don't trip it.
app.use('/api/auth/magic', async (c, next) => {
  if (c.env.RECTO_ENV === 'dev') {
    await next();
    return;
  }
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for') ?? 'local';
  const key = `rl:magic:${ip}`;
  const raw = await c.env.KV.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= 10) {
    return c.json({ error: 'rate_limited', message: 'Try again in a few minutes.' }, 429);
  }
  await c.env.KV.put(key, String(count + 1), { expirationTtl: 600 });
  await next();
});

app.route('/api/health', healthRouter);
app.route('/api/auth', authRouter);
app.route('/api/sites', sitesRouter);
app.route('/api/sites', orphansRouter);
app.route('/api/pushes', pushesRouter);
app.route('/api/sites', candidatesRouter);
app.route('/api/candidates', regenerateAnchorRouter);
app.route('/api/webhooks/appsumo', appsumoRouter);
app.route('/api/errors', errorsRouter);
app.route('/api/workbench', workbenchRouter);
app.route('/api/gsc', gscRouter);
app.route('/api/oauth/gsc', gscOauthRouter);
app.route('/api/users', usersRouter);
app.route('/api/waitlist', waitlistRouter);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  console.error('unhandled', { name: err.name, msg: err.message });
  return c.json({ error: 'internal' }, 500);
});

export { CrawlSession } from './do/CrawlSession';

// The Worker now needs three top-level entry points: fetch (Hono), queue
// (the q-gsc-backfill consumer for D2.3), and scheduled (cron triggers).
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === 'q-gsc-backfill') {
      await handleGscBackfillBatch(batch as MessageBatch<GscBackfillJob>, env);
      return;
    }
    if (batch.queue === 'q-crawl') {
      await handleCrawlBatch(batch as MessageBatch<{ siteId: string; trigger: 'manual' | 'scheduled'; crawlId: string }>, env);
      return;
    }
    if (batch.queue === 'q-embed') {
      await handleEmbedBatch(batch as MessageBatch<{ siteId: string; pageId: string }>, env);
      return;
    }
    if (batch.queue === 'q-push') {
      await handlePushBatch(batch as MessageBatch<{ pushId: string }>, env);
      return;
    }
    if (batch.queue === 'q-verify') {
      await handleVerifyBatch(batch as MessageBatch<{ pushId: string; attempt: number }>, env);
      return;
    }
    if (batch.queue === 'q-email') {
      await handleEmailBatch(batch as MessageBatch<EmailMsg>, env);
      return;
    }
    // Other queues land in later days.
    console.warn('unhandled queue', batch.queue);
    for (const m of batch.messages) m.ack();
  },
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
