import { Hono } from 'hono';
import type { Env } from '../env';

export const healthRouter = new Hono<{ Bindings: Env }>();

healthRouter.get('/', async (c) => {
  // Touch every binding shape so a misconfigured wrangler.toml surfaces during dev.
  const checks: Record<string, string> = {
    env: c.env.RECTO_ENV,
    db: c.env.DB ? 'bound' : 'missing',
    kv: c.env.KV ? 'bound' : 'missing',
    vectorize: c.env.VECTORIZE ? 'bound' : 'missing',
    r2: c.env.R2 ? 'bound' : 'missing',
    ai: c.env.AI ? 'bound' : 'missing',
    browser: c.env.BROWSER ? 'bound' : 'missing',
    crawlSession: c.env.CRAWL_SESSION ? 'bound' : 'missing',
  };

  // D1 ping — confirms the database is reachable. Local: miniflare in-memory; prod: real D1.
  try {
    const row = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
    checks.dbPing = row?.ok === 1 ? 'ok' : 'unexpected';
  } catch (e) {
    checks.dbPing = `fail:${(e as Error).message.slice(0, 80)}`;
  }

  return c.json({ status: 'ok', checks, ts: Date.now() });
});
