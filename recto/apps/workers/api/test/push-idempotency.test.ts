// Regression: q-push idempotency under at-least-once redelivery.
//
// Bug (found + fixed 2026-06-06): a successful CMS write left pushes.status as
// 'pending', the same value a push starts in. The dedup guard was
// `if (row.status !== 'pending') return false`, so a REDELIVERED q-push message
// (Cloudflare Queues are at-least-once) re-ran the push, hit insertLink's
// already-linked short-circuit (wp_already_linked), and markFailure flipped a
// REAL SUCCESS to status='failed' — racing the verifier that was setting
// 'verified'. Fix: success sets status='pushed' (filtered by the guard), and
// wp_already_linked is treated as success (link IS present; verifier confirms).

import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/env';

// Control the push outcome without real crypto/network.
vi.mock('../src/integrations/wordpress', () => ({ pushLink: vi.fn() }));
import { pushLink } from '../src/integrations/wordpress';
import { handlePushBatch } from '../src/jobs/push';

function pushRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pu1', user_id: 'u1', candidate_id: 'c1', status: 'pending',
    anchor_text: 'cold brew', paragraph_excerpt: 'p',
    orphan_slug: '/o', source_page_id: 'sp1', source_slug: '/s',
    site_id: 's1', site_url: 'https://x.com', cms: 'wordpress',
    wp_username: 'u', wp_app_password: new Uint8Array([1, 2, 3]),
    ...over,
  };
}

// sqls collects every prepared statement so we can assert the status transition.
function mockEnv(row: unknown, sqls: string[]): Env {
  return {
    RECTO_KEK: 'MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY=',
    RECTO_ENV: 'dev',
    DB: {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: () => ({
            first: async () => row,
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: [] }),
          }),
        };
      },
    },
    // Cache hit → resolveSlugToPostId returns a postId without decrypt/fetch.
    KV: { get: async () => '123', put: async () => undefined, delete: async () => undefined },
    Q_VERIFY: { send: vi.fn(async () => undefined) },
  } as unknown as Env;
}

function batch(body: unknown) {
  const ack = vi.fn(); const retry = vi.fn();
  return {
    queue: 'q-push',
    messages: [{ id: 'm1', timestamp: new Date(), body, ack, retry, attempts: 1 }],
    ackAll: () => undefined, retryAll: () => undefined,
  } as unknown as MessageBatch<unknown> & { messages: Array<{ ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> };
}

describe('q-push idempotency (at-least-once redelivery)', () => {
  it('a redelivered message on an already-pushed row does NOT re-push', async () => {
    (pushLink as unknown as ReturnType<typeof vi.fn>).mockReset();
    const sqls: string[] = [];
    const env = mockEnv(pushRow({ status: 'pushed' }), sqls);
    const b = batch({ pushId: 'pu1' });
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, env);
    expect(pushLink).not.toHaveBeenCalled();          // never touches the CMS again
    expect((env.Q_VERIFY.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(b.messages[0].ack).toHaveBeenCalled();      // acked, not retried
    expect(b.messages[0].retry).not.toHaveBeenCalled();
  });

  it('a successful push sets status=pushed (NOT pending) so redelivery is filtered', async () => {
    (pushLink as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, revisionId: 9, postId: 9, insertedAt: 123 });
    const sqls: string[] = [];
    const env = mockEnv(pushRow({ status: 'pending' }), sqls);
    const b = batch({ pushId: 'pu1' });
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, env);
    expect(env.Q_VERIFY.send).toHaveBeenCalledTimes(1);
    expect(sqls.some((s) => /status\s*=\s*'pushed'/.test(s))).toBe(true);
    expect(sqls.some((s) => /SET\s+status\s*=\s*'pending'/.test(s))).toBe(false);
    expect(b.messages[0].ack).toHaveBeenCalled();
  });

  it('wp_already_linked is treated as success (status=pushed + verify), never failed', async () => {
    (pushLink as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: 'wp_already_linked' });
    const sqls: string[] = [];
    const env = mockEnv(pushRow({ status: 'pending' }), sqls);
    const b = batch({ pushId: 'pu1' });
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, env);
    expect(env.Q_VERIFY.send).toHaveBeenCalledTimes(1);
    expect(sqls.some((s) => /status\s*=\s*'pushed'/.test(s))).toBe(true);
    expect(sqls.some((s) => /status\s*=\s*'failed'/.test(s))).toBe(false);
    expect(b.messages[0].ack).toHaveBeenCalled();
  });
});
