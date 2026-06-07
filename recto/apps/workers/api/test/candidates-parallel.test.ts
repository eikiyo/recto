// Perf regression guard (2026-06-07): the candidates compute path generates
// the per-candidate anchor via selectAnchorPhrase. Those calls are independent
// Workers-AI round-trips and MUST run concurrently (Promise.all), not in a
// sequential `for await` — the sequential form stacked SHOW_K × model latency
// onto every cold "Fix this" click. This test drives the REAL router with a
// concurrency-recording AI stub and asserts the calls overlap, and that the
// response is still correct (3 sorted candidates).

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Bypass auth: requireSession -> loadSession; force a valid session.
vi.mock('../src/auth/session', () => ({
  loadSession: vi.fn(async () => ({ userId: 'u1', sessionId: 's1' })),
  SESSION_COOKIE: 'recto_session',
}));

import { candidatesRouter } from '../src/routes/candidates';

const ORPHAN = { id: 'orph1', slug: '/orphan-widgets', title: 'Best Widgets', h1: 'Best Widgets', excerpt: 'a guide about widgets and gadgets' };
// Three sibling source pages, all overlapping the orphan tokens so lexicalTopK
// ranks them. Each body contains a clean phrase the AI can echo.
const POOL = [
  { id: 'src1', title: 'Widgets 101', h1: 'Widgets 101', excerpt: 'widgets overview' },
  { id: 'src2', title: 'Gadgets and widgets', h1: 'Gadgets and widgets', excerpt: 'gadgets and widgets' },
  { id: 'src3', title: 'Choosing widgets', h1: 'Choosing widgets', excerpt: 'choosing widgets guide' },
];
const SOURCE_ROWS = POOL.map((p, i) => ({
  id: p.id, slug: '/' + p.id, title: p.title, h1: p.h1, excerpt: p.excerpt,
  body_text: `This is a useful guide here about widgets and gadgets number ${i}. Read more on widgets.`,
  impressions_28d: (3 - i) * 100,
}));

function makeDb() {
  return {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        first: async () => {
          if (/FROM pages p\s+JOIN sites s/.test(sql)) return ORPHAN;            // orphan load
          if (/FROM users WHERE id/.test(sql)) return { byok_openai_key: null, byok_anthropic_key: null, digest_opt_in: 1 };
          if (/SELECT id FROM candidates WHERE orphan_page_id/.test(sql)) return null; // existing -> insert path
          return null;
        },
        all: async () => {
          if (/FROM candidates cd\s+JOIN pages sp/.test(sql)) return { results: [] };  // cache miss -> compute
          if (/FROM pages p\s+WHERE p\.site_id = \?/.test(sql)) return { results: POOL }; // lexical pool
          if (/LEFT JOIN gsc_data g/.test(sql)) return { results: SOURCE_ROWS };         // source rows
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  };
}

describe('candidates compute path — anchor generation runs concurrently', () => {
  it('overlaps the per-candidate Workers-AI calls and returns 3 sorted candidates', async () => {
    let active = 0, maxConcurrent = 0, calls = 0;
    const AI = {
      run: vi.fn(async () => {
        calls++; active++; maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 25)); // hold the slot so overlap is observable
        active--;
        return { response: 'useful guide here' };
      }),
    };
    const env = {
      RECTO_KEK: 'MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY=',
      RECTO_ENV: 'dev',
      AI,
      // VECTORIZE intentionally absent -> forces the lexical fallback (no index needed).
      DB: makeDb(),
    } as unknown as Parameters<typeof candidatesRouter.fetch>[1];

    const app = new Hono();
    app.route('/api/sites', candidatesRouter);

    const res = await app.request(
      '/api/sites/site1/orphans/orph1/candidates',
      { headers: { Cookie: 'recto_session=x' } },
      env as unknown as Record<string, unknown>
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ id: string; sourceSlug: string; similarity: number }> };

    // Correctness: 3 candidates, each with a source slug, sorted by similarity desc.
    expect(body.candidates).toHaveLength(3);
    expect(body.candidates.every((c) => typeof c.sourceSlug === 'string' && c.sourceSlug.length > 0)).toBe(true);
    const sims = body.candidates.map((c) => c.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);

    // Concurrency: the AI calls must have overlapped. Sequential => maxConcurrent === 1.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
