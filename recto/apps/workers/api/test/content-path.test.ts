// Silent-content-loss regression (2026-06-07): isContentPath gates the crawl
// BFS enqueue (do/CrawlSession.ts:133) AND orphan/source selection. The system
// prefix list was matched with a bare `path.startsWith(pfx)` and no segment
// boundary, so a real post whose slug merely STARTED with a system word was
// silently dropped from the entire pipeline: `/feedback` killed by `/feed`,
// `/search-engine-tips` by `/search`, `/cartoons` by `/cart`, `/checkout-guide`
// by `/checkout`. This pins the boundary: a system prefix matches only the path
// itself or a descendant segment, never a longer word.

import { describe, it, expect } from 'vitest';
import { isContentPath } from '../src/lib/url-norm';

const B = 'https://example.com';

describe('isContentPath — system prefixes match on a segment boundary, not a substring', () => {
  it('REAL posts that merely share a system prefix are kept (the bug)', () => {
    expect(isContentPath(`${B}/feedback`)).toBe(true);          // not /feed
    expect(isContentPath(`${B}/feedback-form`)).toBe(true);
    expect(isContentPath(`${B}/search-engine-tips`)).toBe(true); // not /search
    expect(isContentPath(`${B}/cartoons`)).toBe(true);           // not /cart
    expect(isContentPath(`${B}/cartography-basics`)).toBe(true);
    expect(isContentPath(`${B}/checkout-guide`)).toBe(true);     // not /checkout
    expect(isContentPath(`${B}/tagline-writing`)).toBe(true);    // not /tag/
    expect(isContentPath(`${B}/authority-building`)).toBe(true); // not /author/
    expect(isContentPath(`${B}/categorically-true`)).toBe(true); // not /category/
  });

  it('genuine WordPress system routes are still dropped', () => {
    expect(isContentPath(`${B}/feed`)).toBe(false);
    expect(isContentPath(`${B}/feed/`)).toBe(false);
    expect(isContentPath(`${B}/comments/feed`)).toBe(false);
    expect(isContentPath(`${B}/search`)).toBe(false);
    expect(isContentPath(`${B}/cart`)).toBe(false);
    expect(isContentPath(`${B}/checkout`)).toBe(false);
    expect(isContentPath(`${B}/wp-admin`)).toBe(false);
    expect(isContentPath(`${B}/wp-admin/options.php`)).toBe(false);
    expect(isContentPath(`${B}/wp-content/uploads/x.png`)).toBe(false);
    expect(isContentPath(`${B}/wp-login.php`)).toBe(false);
    expect(isContentPath(`${B}/author/jane`)).toBe(false);
    expect(isContentPath(`${B}/tag/seo`)).toBe(false);
    expect(isContentPath(`${B}/category/news`)).toBe(false);
    expect(isContentPath(`${B}/page/2`)).toBe(false);
    expect(isContentPath(`${B}/xmlrpc.php`)).toBe(false);
    expect(isContentPath(`${B}/wp-sitemap.xml`)).toBe(false); // via .xml ext too
  });

  it('ordinary content pages pass', () => {
    expect(isContentPath(`${B}/`)).toBe(true);
    expect(isContentPath(`${B}/about`)).toBe(true);
    expect(isContentPath(`${B}/2024/05/my-post`)).toBe(true);
    expect(isContentPath(`${B}/best-cold-brew-recipe`)).toBe(true);
  });

  it('query-string and attachment routes still filtered', () => {
    expect(isContentPath(`${B}/post?replytocom=12`)).toBe(false);
    expect(isContentPath(`${B}/post?preview=true`)).toBe(false);
    expect(isContentPath(`${B}/brochure.pdf`)).toBe(false);
  });
});
