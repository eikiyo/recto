// Perf regression guard (2026-06-07): GET /api/workbench/since computes three
// independent COUNT reads (new pages / new orphans / new candidates). They were
// awaited serially, stacking 3× D1 round-trip latency onto the workbench top
// block on every load. Fix: Promise.all the three reads. This test drives the
// REAL router with a concurrency-recording DB stub and asserts the COUNT reads
// overlap AND that the response numbers are still correct.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Bypass auth: force a valid session (userId + sessionId).
vi.mock('../src/auth/session', () => ({
  loadSession: vi.fn(async () => ({ userId: 'u1', sessionId: 's-current' })),
  SESSION_COOKIE: 'recto_session',
}));

import { workbenchRouter } from '../src/routes/workbench';

describe('GET /api/workbench/since — the three counts run concurrently', () => {
  it('overlaps the COUNT round-trips and returns correct pages/orphans/candidates', async () => {
    let active = 0, maxConcurrent = 0;
    // Each COUNT query returns a distinct number so we can prove the mapping.
    const countFor = (sql: string): number => {
      if (/AND NOT EXISTS \(SELECT 1 FROM edges/.test(sql)) return 4;      // orphans
      if (/FROM candidates c/.test(sql)) return 7;                          // candidates
      if (/FROM pages p JOIN sites s/.test(sql)) return 11;                 // pages
      return 0;
    };

    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (..._a: unknown[]) => ({
            first: async () => {
              // The "previous session" lookup resolves immediately (not a COUNT).
              if (/FROM sessions/.test(sql)) return { expires_at: 0 };
              active++; maxConcurrent = Math.max(maxConcurrent, active);
              await new Promise((r) => setTimeout(r, 25)); // hold the slot so overlap is observable
              active--;
              return { n: countFor(sql) };
            },
          }),
        }),
      },
    } as unknown as Parameters<typeof workbenchRouter.fetch>[1];

    const app = new Hono();
    app.route('/api/workbench', workbenchRouter);

    const res = await app.request(
      '/api/workbench/since',
      { headers: { Cookie: 'recto_session=x' } },
      env as unknown as Record<string, unknown>
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pages: number; orphans: number; candidates: number };

    // Correctness: each count mapped to the right field.
    expect(body.pages).toBe(11);
    expect(body.orphans).toBe(4);
    expect(body.candidates).toBe(7);

    // Concurrency: the three COUNT reads must have overlapped. Serial => maxConcurrent === 1.
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
