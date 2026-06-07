// Regression (2026-06-07): the live-page verifier flipped a SUCCESSFUL push to
// status='failed' whenever it merely couldn't REACH the host after MAX_ATTEMPTS
// — same bug class as the push slug-resolution one (transient treated as
// permanent). Fix: only 'invisible' (reached the page, link absent) fails the
// push; 'network'/'http' leaves it 'pushed' and the daily reverify sweep
// re-confirms it — so the sweep must also pick up stale 'pushed' rows.

import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/env';
import { handleVerifyBatch } from '../src/jobs/verify';
import { reverifySweep } from '../src/crons/reverify';

function verifyBatch(body: unknown, attempts = 1) {
  return {
    queue: 'q-verify',
    messages: [{ id: 'm1', timestamp: new Date(), body, ack: vi.fn(), retry: vi.fn(), attempts }],
    ackAll: () => undefined, retryAll: () => undefined,
  } as unknown as MessageBatch<unknown>;
}

describe('verify: only a genuinely-invisible link fails the push at exhaustion', () => {
  it("reached the page + link ABSENT after MAX_ATTEMPTS → status='failed' wp_post_failed", async () => {
    const origFetch = globalThis.fetch;
    // 200 OK but the HTML has no recto link/marker → genuine 'invisible'.
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('<html><body>nothing here</body></html>', { status: 200 }));
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      RECTO_KEK: 'k', RECTO_ENV: 'dev',
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => ({ id: 'p1', status: 'pushed', anchor_text: 'a', orphan_slug: '/o', source_slug: '/s', site_url: 'https://x.com' }),
            run: async () => { calls.push({ sql, args }); return { meta: { changes: 1 } }; },
            all: async () => ({ results: [] }),
          }),
        }),
      },
      Q_VERIFY: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    try {
      await handleVerifyBatch(verifyBatch({ pushId: 'p1', attempt: 3 }), env);
      const failed = calls.find((c) => /SET\s+status\s*=\s*'failed'/.test(c.sql));
      expect(failed).toBeDefined();
      expect(failed!.args).toContain('wp_post_failed');
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });
});

describe('reverifySweep: re-confirms stale pushed rows, not only verified', () => {
  it("query targets both status='verified' and status='pushed', and enqueues returned ids", async () => {
    let capturedSql = '';
    const env = {
      DB: {
        prepare: (sql: string) => { capturedSql = sql; return {
          bind: () => ({ all: async () => ({ results: [{ id: 'pa' }, { id: 'pb' }] }) }),
        }; },
      },
      Q_VERIFY: { send: vi.fn(async () => undefined) },
    } as unknown as Env;

    await reverifySweep(env);

    expect(capturedSql).toMatch(/status\s*=\s*'verified'/);
    expect(capturedSql).toMatch(/status\s*=\s*'pushed'/);
    expect(capturedSql).toMatch(/pushed_at\s*<\s*\?/);
    expect((env.Q_VERIFY.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});
