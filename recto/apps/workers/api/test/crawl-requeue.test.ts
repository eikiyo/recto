// Regression (2026-06-07): a crawl tick pulls BATCH_SIZE=25 URLs from the DO
// (spliced off its queue) but breaks the loop at PER_INVOCATION_BUDGET_MS=22s.
// 25 × POLITENESS_MS(1s) > 22s, so the tail was hit mid-batch every tick — and
// because /work had already removed those URLs from the queue, the unreached
// ones were silently dropped (the site under-covered). Fix: the tick returns
// the unprocessed tail and the DO re-queues it (front, no total double-count).

import { describe, it, expect } from 'vitest';
import { CrawlSession } from '../src/do/CrawlSession';

function mockState() {
  const store = new Map<string, unknown>();
  return {
    state: {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => { store.set(k, v); },
      },
    },
    store,
  };
}

async function readJson(res: Response) { return res.json() as Promise<Record<string, unknown>>; }

describe('CrawlSession.persist re-queues the unprocessed tail (no silent drop)', () => {
  it('URLs pulled but not processed go back on the queue; total is not double-counted', async () => {
    const { state, store } = mockState();
    const session = new CrawlSession(state as unknown as DurableObjectState, {} as never);
    const seeds = ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'];

    await session.fetch(new Request('https://do/init', { method: 'POST', body: JSON.stringify({ crawlId: 'c1', siteId: 's1', seedUrls: seeds }) }));
    // Pull the batch (splices all 3 off the queue).
    const work = await readJson(await session.fetch(new Request('https://do/work', { method: 'POST' })));
    expect((work.batch as string[]).length).toBe(3);
    expect(store.get('queue')).toEqual([]); // queue drained by /work

    // Simulate: only 'a' processed; b + c hit the time budget → unprocessed.
    await session.fetch(new Request('https://do/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processed: [{ url: 'https://x.com/a', ok: true, slug: '/a' }],
        discovered: [],
        unprocessed: ['https://x.com/b', 'https://x.com/c'],
      }),
    }));

    const queue = store.get('queue') as string[];
    // b and c are back on the queue — NOT dropped.
    expect(new Set(queue)).toEqual(new Set(['https://x.com/b', 'https://x.com/c']));

    const progress = (await readJson(await session.fetch(new Request('https://do/state')))) as { total: number; done: number; complete: boolean };
    expect(progress.done).toBe(1);          // only 'a'
    expect(progress.total).toBe(3);          // NOT bumped to 5 by re-queue
    expect(progress.complete).toBe(false);   // work remains
  });

  it('an already-visited unprocessed URL is not re-queued (no duplicate)', async () => {
    const { state, store } = mockState();
    const session = new CrawlSession(state as unknown as DurableObjectState, {} as never);
    await session.fetch(new Request('https://do/init', { method: 'POST', body: JSON.stringify({ crawlId: 'c1', siteId: 's1', seedUrls: ['https://x.com/a'] }) }));
    await session.fetch(new Request('https://do/work', { method: 'POST' }));
    // 'a' both processed AND (defensively) listed as unprocessed — must not double-add.
    await session.fetch(new Request('https://do/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processed: [{ url: 'https://x.com/a', ok: true, slug: '/a' }],
        discovered: [],
        unprocessed: ['https://x.com/a'],
      }),
    }));
    expect(store.get('queue')).toEqual([]); // visited → not re-queued
  });
});
