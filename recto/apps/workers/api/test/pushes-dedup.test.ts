// Hardening regression (2026-06-07): POST /api/pushes minted a fresh push row on
// every call, so a double-click created TWO active pushes for one candidate (two
// q-push messages, two WP round-trips, two verify enqueues, duplicate audit
// rows). The per-pushId job guard only dedups message REDELIVERY; it can't see a
// second ROW. Fix: if an active (pending/pushed/verified) push already exists for
// the candidate, return it (deduped) instead of inserting. 'failed'/'undone' stay
// re-pushable. This test drives the REAL pushesRouter.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/auth/session', () => ({
  loadSession: vi.fn(async () => ({ userId: 'u1', sessionId: 's1' })),
  SESSION_COOKIE: 'recto_session',
}));

import { pushesRouter } from '../src/routes/pushes';

// Build an env whose DB answers the candidate-load and the active-push lookup
// from supplied fixtures, and records every INSERT + queue send.
function makeEnv(opts: { activePush: { id: string; status: string } | null }) {
  const inserts: string[] = [];
  const qsends: unknown[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (..._a: unknown[]) => ({
          first: async () => {
            if (/FROM candidates c/.test(sql)) return { id: 'cand1', anchor_text: 'cold brew' };
            if (/FROM pushes\s+WHERE candidate_id/.test(sql)) return opts.activePush;
            return null;
          },
          run: async () => { if (/INSERT INTO pushes/.test(sql)) inserts.push(sql); return { meta: { changes: 1 } }; },
          all: async () => ({ results: [] }),
        }),
      }),
    },
    Q_PUSH: { send: vi.fn(async (m: unknown) => { qsends.push(m); }) },
  } as unknown as Parameters<typeof pushesRouter.fetch>[1];
  return { env, inserts, qsends };
}

function app() { const a = new Hono(); a.route('/api/pushes', pushesRouter); return a; }
const post = () => ({ method: 'POST', headers: { Cookie: 'recto_session=x', 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: 'cand1' }) });

describe('POST /api/pushes — idempotent per active candidate push', () => {
  it('an existing PENDING push is returned deduped; no new row, no new queue message', async () => {
    const { env, inserts, qsends } = makeEnv({ activePush: { id: 'existing1', status: 'pending' } });
    const res = await app().request('/api/pushes', post(), env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; deduped?: boolean };
    expect(body.id).toBe('existing1');
    expect(body.deduped).toBe(true);
    expect(inserts).toHaveLength(0);                  // no duplicate row
    expect((env.Q_PUSH.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(qsends).toHaveLength(0);
  });

  it('no active push → creates a new one and enqueues (202)', async () => {
    const { env, inserts, qsends } = makeEnv({ activePush: null });
    const res = await app().request('/api/pushes', post(), env as unknown as Record<string, unknown>);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('pending');
    expect(inserts).toHaveLength(1);                  // exactly one insert
    expect((env.Q_PUSH.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(qsends).toHaveLength(1);
  });
});
