// Shared CORS origin allow-list. Used by the global CORS middleware (index.ts)
// AND by routes that return a Response directly (e.g. the SSE stream), which
// bypass the middleware's c.header() calls and must re-apply CORS themselves.

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  'https://rectoapp.com',
  'https://www.rectoapp.com',
]);

export function originAllowed(o: string | undefined): boolean {
  if (!o) return false;
  if (ALLOWED_ORIGINS.has(o)) return true;
  // Pages preview deploys live at *.recto-ui.pages.dev.
  return /^https:\/\/[a-z0-9-]+\.recto-ui\.pages\.dev$/.test(o)
    || o === 'https://recto-ui.pages.dev';
}

// Apply credentialed-CORS headers to a Response built outside the middleware
// (streamed SSE). No-op when the origin isn't allowed.
export function withCors(res: Response, origin: string | undefined): Response {
  if (!origin || !originAllowed(origin)) return res;
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
