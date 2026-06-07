// Seed-noise regression (2026-06-07): discoverSitemap() feeds the sitemap's URLs
// straight into CrawlSession /init, which queued them RAW. The discovered-URL
// path in persist() filters WP system/archive routes via isContentPath, but the
// seed path did not — so /category/, /author/, /tag/, /feed, /cart, attachment
// pages listed in a sitemap got crawled, stored in `pages`, and surfaced as
// orphan/source candidates (the exact noise persist strips). This drives the
// REAL CrawlSession.init through a fake DO storage and asserts only content
// seeds reach the queue.

import { describe, it, expect } from 'vitest';
import type { Env } from '../src/env';
import { CrawlSession } from '../src/do/CrawlSession';

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    store,
    state: {
      storage: {
        get: async <T>(k: string) => store.get(k) as T | undefined,
        put: async (k: string, v: unknown) => { store.set(k, v); },
      },
    } as unknown as DurableObjectState,
  };
}

async function runInit(seedUrls: string[]) {
  const { state, store } = fakeState();
  const session = new CrawlSession(state, {} as Env);
  const res = await session.fetch(
    new Request('https://do/init', {
      method: 'POST',
      body: JSON.stringify({ crawlId: 'c1', siteId: 's1', seedUrls }),
    })
  );
  const out = (await res.json()) as { ok: boolean; total: number };
  return { out, queue: (store.get('queue') as string[]) ?? [] };
}

describe('CrawlSession.init — seeds pass through the content gate', () => {
  it('drops WP system/archive seeds, keeps real content seeds', async () => {
    const seeds = [
      'https://example.com/',                       // homepage — keep
      'https://example.com/best-cold-brew',         // post — keep
      'https://example.com/2024/05/another-post',   // post — keep
      'https://example.com/category/news',          // archive — drop
      'https://example.com/author/jane',            // archive — drop
      'https://example.com/tag/seo',                // archive — drop
      'https://example.com/feed',                   // feed — drop
      'https://example.com/cart',                   // woo — drop
      'https://example.com/brochure.pdf',           // attachment — drop
    ];
    const { out, queue } = await runInit(seeds);
    expect(queue).toEqual([
      'https://example.com/',
      'https://example.com/best-cold-brew',
      'https://example.com/2024/05/another-post',
    ]);
    expect(out.total).toBe(3);
  });

  it('a real post whose slug shares a system prefix survives (boundary)', async () => {
    const { queue } = await runInit([
      'https://example.com/feedback',   // not /feed
      'https://example.com/cartoons',   // not /cart
    ]);
    expect(queue).toEqual([
      'https://example.com/feedback',
      'https://example.com/cartoons',
    ]);
  });

  it('an all-system sitemap yields an empty (immediately complete) crawl', async () => {
    const { out, queue } = await runInit([
      'https://example.com/wp-admin',
      'https://example.com/feed',
    ]);
    expect(queue).toEqual([]);
    expect(out.total).toBe(0);
  });
});
