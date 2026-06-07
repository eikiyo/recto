// Silent-data-loss regression (2026-06-07): gsc-backfill joined GSC rows to
// pages by `new URL(gscUrl).pathname`, which KEEPS the trailing slash. But
// pages.slug is stored as pathOf(normalizeUrl(crawledUrl)), and normalizeUrl
// STRIPS the trailing slash — so Google's `/my-post/` never matched the stored
// `/my-post`, and 28-day impressions (the orphan ranking's primary signal) were
// silently dropped for every trailing-slash (i.e. default WordPress) page. This
// test pins toSlug == the exact slug the crawler stores.

import { describe, it, expect } from 'vitest';
import { toSlug } from '../src/jobs/gsc-backfill';
import { normalizeUrl, pathOf } from '../src/lib/url-norm';

// How pages.slug is actually produced in jobs/crawl.ts (crawlOne): the crawled
// URL has already been normalizeUrl'd (seeds via discoverSitemap, links via the
// BFS), then slug = pathOf(thatUrl).
function storedSlug(crawledUrl: string): string {
  const norm = normalizeUrl(crawledUrl);
  return norm ? pathOf(norm) : crawledUrl;
}

describe('gsc toSlug matches the stored pages.slug (join must not miss)', () => {
  it('a trailing-slash WordPress permalink joins to the stored slug', () => {
    const gscUrl = 'https://example.com/my-post/';   // Google reports the slash
    const seedUrl = 'https://example.com/my-post/';  // sitemap lists the slash too
    expect(toSlug(gscUrl)).toBe(storedSlug(seedUrl));
    expect(toSlug(gscUrl)).toBe('/my-post');          // both land slash-stripped
  });

  it('nested permalinks (dated WP) join', () => {
    expect(toSlug('https://example.com/2024/05/cold-brew/')).toBe(storedSlug('https://example.com/2024/05/cold-brew/'));
    expect(toSlug('https://example.com/2024/05/cold-brew/')).toBe('/2024/05/cold-brew');
  });

  it('the root path stays "/" (not emptied or stripped to "")', () => {
    expect(toSlug('https://example.com/')).toBe('/');
    expect(toSlug('https://example.com/')).toBe(storedSlug('https://example.com/'));
  });

  it('query/hash on the GSC url do not leak into the slug', () => {
    expect(toSlug('https://example.com/my-post/?utm=x#frag')).toBe('/my-post');
  });

  it('no-trailing-slash url still matches (idempotent)', () => {
    expect(toSlug('https://example.com/page')).toBe('/page');
    expect(toSlug('https://example.com/page')).toBe(storedSlug('https://example.com/page'));
  });
});
