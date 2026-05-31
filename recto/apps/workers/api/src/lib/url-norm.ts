// URL normalization. Keep canonical form stable so dedup works.

export function normalizeUrl(input: string, base?: string): string | null {
  try {
    const u = new URL(input, base);
    u.hash = '';
    // Lowercase host. Strip trailing slash unless it's the root path.
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Sort the query string for deterministic equality.
    if (u.search) {
      const params = Array.from(u.searchParams.entries()).sort((a, b) =>
        a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])
      );
      u.search = '';
      for (const [k, v] of params) u.searchParams.append(k, v);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function sameOrigin(a: string, b: string): boolean {
  return originOf(a) === originOf(b) && originOf(a) !== '';
}

// WordPress sites expose many non-content URLs that appear in the sitemap or
// internal nav: login, admin, REST endpoints, JSON feeds, search results,
// preview/replytocom query strings, attachment pages. Surfacing these as
// orphans is noise that wrecks Mira's first impression.
//
// Returns true when the path looks like content; false when it should be
// skipped at crawl ingest and at orphan/source candidate selection.
const SYSTEM_PATH_PREFIXES = [
  '/wp-admin', '/wp-login.php', '/wp-content/', '/wp-includes/', '/wp-json',
  '/feed', '/comments/feed', '/xmlrpc.php', '/wp-cron.php', '/wp-sitemap',
  '/author/', '/tag/', '/category/', '/page/',
  '/?', '/search', '/cart', '/checkout', '/my-account',
];
const SYSTEM_EXACT_PATHS = new Set([
  '/sample-page', '/hello-world', '/cart', '/checkout', '/my-account', '/wp-login.php',
]);
const SYSTEM_QUERY_KEYS = ['replytocom', 'preview', 'p', 'attachment_id', 'unapproved'];

export function isContentPath(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname;
    if (SYSTEM_EXACT_PATHS.has(path)) return false;
    for (const pfx of SYSTEM_PATH_PREFIXES) {
      if (path === pfx || path.startsWith(pfx)) return false;
    }
    for (const k of SYSTEM_QUERY_KEYS) {
      if (u.searchParams.has(k)) return false;
    }
    // Common attachment extensions.
    if (/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp3|mp4|webm|json|xml|css|js)$/i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}
