// Sitemap discovery — sitemap.xml + sitemap index recursion.
// Falls back to caller-driven BFS from the homepage when no sitemap is reachable.
//
// We do NOT parse with a full XML library. Sitemaps are well-defined; regex
// is sufficient and avoids pulling in a dependency.

import { normalizeUrl, sameOrigin } from './url-norm';
import { fetchWithTimeout, readTextCapped } from './http';

const URL_RE = /<loc>([^<]+)<\/loc>/g;
const MAX_SITEMAPS = 25;
const SITEMAP_TIMEOUT_MS = 8_000;     // an untrusted sitemap host can't hang the crawl
const SITEMAP_MAX_BYTES = 5_000_000;  // 5 MB cap — a huge sitemap can't OOM the Worker

export type SitemapResult = {
  source: 'sitemap' | 'fallback';
  urls: string[];
};

export async function discoverSitemap(siteUrl: string): Promise<SitemapResult> {
  const candidates = [
    new URL('/sitemap.xml', siteUrl).toString(),
    new URL('/sitemap_index.xml', siteUrl).toString(),
    new URL('/wp-sitemap.xml', siteUrl).toString(),
  ];
  for (const u of candidates) {
    const urls = await fetchSitemapTree(u, 0);
    if (urls.length > 0) {
      // Only ever seed the site's OWN pages. Sitemaps (and especially sitemap
      // indexes pointing at a CDN or a linked domain) can list cross-origin
      // URLs; crawling those would pollute the pages table with off-site
      // content and break orphan detection. (Hardened 2026-06-06.)
      const sameSite = urls.filter((u2) => sameOrigin(u2, siteUrl));
      if (sameSite.length > 0) return { source: 'sitemap', urls: sameSite };
    }
  }
  // Fallback: caller will BFS from the homepage.
  return { source: 'fallback', urls: [siteUrl] };
}

async function fetchSitemapTree(url: string, depth: number): Promise<string[]> {
  if (depth > 2) return []; // sitemap index of index of index — very unusual
  let body: string;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'recto-crawler/1.0 (+https://recto.so)' } },
      SITEMAP_TIMEOUT_MS
    );
    if (!res.ok) return [];
    body = await readTextCapped(res, SITEMAP_MAX_BYTES);
  } catch {
    return [];
  }

  const isIndex = /<sitemapindex/i.test(body);
  const matches = [...body.matchAll(URL_RE)]
    .map((m) => (m[1] ?? '').trim())
    .filter(Boolean);

  if (isIndex) {
    const out: string[] = [];
    const sitemaps = matches.slice(0, MAX_SITEMAPS);
    for (const sub of sitemaps) {
      const child = await fetchSitemapTree(sub, depth + 1);
      out.push(...child);
    }
    return out;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const n = normalizeUrl(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    normalized.push(n);
  }
  return normalized;
}
