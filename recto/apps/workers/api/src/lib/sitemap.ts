// Sitemap discovery — sitemap.xml + sitemap index recursion.
// Falls back to caller-driven BFS from the homepage when no sitemap is reachable.
//
// We do NOT parse with a full XML library. Sitemaps are well-defined; regex
// is sufficient and avoids pulling in a dependency.

import { normalizeUrl } from './url-norm';

const URL_RE = /<loc>([^<]+)<\/loc>/g;
const MAX_SITEMAPS = 25;

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
      return { source: 'sitemap', urls };
    }
  }
  // Fallback: caller will BFS from the homepage.
  return { source: 'fallback', urls: [siteUrl] };
}

async function fetchSitemapTree(url: string, depth: number): Promise<string[]> {
  if (depth > 2) return []; // sitemap index of index of index — very unusual
  let body: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'recto-crawler/1.0 (+https://recto.so)' },
    });
    if (!res.ok) return [];
    body = await res.text();
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
