// Regression (2026-06-07): resolveSlugToPostId returned `null` for BOTH a
// genuine "post not found" AND a transient failure reaching WordPress (timeout,
// network, 5xx). runPush then recorded a permanent wp_post_not_found with no
// retry — so a brief WP outage during slug resolution killed the core action
// and forced a manual retry. Fix: transient failures return 'transient' and are
// retried on the bounded MAX_RETRY schedule (then give up as wp_network);
// genuine 4xx/empty stays a permanent wp_post_not_found.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/env';

vi.mock('../src/lib/crypto', () => ({ decrypt: vi.fn(async () => 'app-pass') }));
vi.mock('../src/integrations/wordpress', () => ({
  pushLink: vi.fn(async () => ({ ok: true, postId: 5, insertedAt: 111 })),
}));

// Controllable WP response for resolveSlugToPostId's fetch.
type Fake = { ok: boolean; status: number; json: () => Promise<unknown> };
let nextResponse: Fake | { throws: true };
vi.mock('../src/lib/http', () => ({
  fetchWithTimeout: vi.fn(async () => {
    if ('throws' in nextResponse) throw new Error('network down');
    return nextResponse as unknown as Response;
  }),
  readTextCapped: vi.fn(),
}));

import { pushLink } from '../src/integrations/wordpress';
import { handlePushBatch } from '../src/jobs/push';

function pushRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pu1', user_id: 'u1', candidate_id: 'c1', status: 'pending',
    anchor_text: 'cold brew', paragraph_excerpt: 'p',
    orphan_slug: '/o', source_page_id: 'sp1', source_slug: '/source-post',
    site_id: 's1', site_url: 'https://x.com', cms: 'wordpress',
    wp_username: 'u', wp_app_password: new Uint8Array([1, 2, 3]),
    ...over,
  };
}

function mockEnv(calls: Array<{ sql: string; args: unknown[] }>): Env {
  return {
    RECTO_KEK: 'MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY=',
    RECTO_ENV: 'dev',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => pushRow(),
          run: async () => { calls.push({ sql, args }); return { meta: { changes: 1 } }; },
          all: async () => ({ results: [] }),
        }),
      }),
    },
    KV: { get: async () => null, put: async () => undefined, delete: async () => undefined }, // cache MISS → real resolution path
    Q_VERIFY: { send: vi.fn(async () => undefined) },
  } as unknown as Env;
}

function batch(body: unknown, attempts = 1) {
  const ack = vi.fn(); const retry = vi.fn();
  return {
    queue: 'q-push',
    messages: [{ id: 'm1', timestamp: new Date(), body, ack, retry, attempts }],
    ackAll: () => undefined, retryAll: () => undefined,
  } as unknown as MessageBatch<unknown> & { messages: Array<{ ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> };
}

const failed = (calls: Array<{ sql: string; args: unknown[] }>) =>
  calls.find((c) => /SET\s+status\s*=\s*'failed'/.test(c.sql));

describe('push slug-resolution: transient vs permanent', () => {
  beforeEach(() => { (pushLink as unknown as ReturnType<typeof vi.fn>).mockClear(); });

  it('5xx during resolution RETRIES (not a permanent failure)', async () => {
    nextResponse = { ok: false, status: 503, json: async () => ({}) };
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const b = batch({ pushId: 'pu1' }, 1);
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, mockEnv(calls));
    expect(b.messages[0].retry).toHaveBeenCalled();   // requeued
    expect(b.messages[0].ack).not.toHaveBeenCalled();
    expect(failed(calls)).toBeUndefined();            // never marked failed
  });

  it('network throw during resolution RETRIES', async () => {
    nextResponse = { throws: true };
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const b = batch({ pushId: 'pu1' }, 1);
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, mockEnv(calls));
    expect(b.messages[0].retry).toHaveBeenCalled();
    expect(failed(calls)).toBeUndefined();
  });

  it('after MAX_RETRY a transient gives up as wp_network (NOT wp_post_not_found)', async () => {
    nextResponse = { ok: false, status: 503, json: async () => ({}) };
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const b = batch({ pushId: 'pu1' }, 3); // attempt === MAX_RETRY
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, mockEnv(calls));
    const f = failed(calls);
    expect(f).toBeDefined();
    expect(f!.args).toContain('wp_network');
    expect(f!.args).not.toContain('wp_post_not_found');
    expect(b.messages[0].ack).toHaveBeenCalled();
  });

  it('genuine empty result is a PERMANENT wp_post_not_found (no retry)', async () => {
    nextResponse = { ok: true, status: 200, json: async () => [] };
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const b = batch({ pushId: 'pu1' }, 1);
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, mockEnv(calls));
    const f = failed(calls);
    expect(f).toBeDefined();
    expect(f!.args).toContain('wp_post_not_found');
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(pushLink).not.toHaveBeenCalled();
  });

  it('a resolved post id proceeds to pushLink (success regression)', async () => {
    nextResponse = { ok: true, status: 200, json: async () => [{ id: 5 }] };
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const env = mockEnv(calls);
    const b = batch({ pushId: 'pu1' }, 1);
    await handlePushBatch(b as unknown as MessageBatch<{ pushId: string }>, env);
    expect(pushLink).toHaveBeenCalledTimes(1);
    expect((env.Q_VERIFY.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
