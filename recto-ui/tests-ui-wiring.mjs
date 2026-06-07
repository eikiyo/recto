// Real-stack UI wiring verification. Serves recto-ui static on localhost:8787
// (same origin api.js targets for localhost → no CORS) and runs the REAL
// app-shell.js + api.js + pages.js unmodified, with ONLY the network (/api/**)
// stubbed via Playwright route. This exercises the exact deployed frontend code
// — CSP, dispatcher, event wiring, label logic — through a real browser.
import { chromium } from '@playwright/test';

const ORIGIN = 'http://localhost:8787';
const SITE = 'site_test';
const ORPHAN = 'orph_1';

const ORPHANS = [
  { id: 'orph_1', slug: '/alpha', title: 'Alpha Post', score: 90, gsc: { impressions28d: 1200 } },
  { id: 'orph_2', slug: '/beta',  title: 'Beta Post',  score: 70, gsc: { impressions28d: 300 } },
];
const CANDIDATES = [
  { id: 'cand_1', source_page_id: 'pg_1', source_slug: '/host', source_title: 'Host Page',
    anchor_text: 'great alpha', snippet: 'read about great alpha here', score: 88 },
];
const PUSHES = [
  { id: 'pu_pushed', status: 'pushed', pushed_at: Date.now() - 60000, anchor_text: 'great alpha',
    orphan_slug: '/alpha', source_slug: '/host', site_url: 'https://demo.example.com', site_id: SITE },
  { id: 'pu_verified', status: 'verified', verified_via: 'http', pushed_at: Date.now() - 120000,
    anchor_text: 'beta link', orphan_slug: '/beta', source_slug: '/host2', site_url: 'https://demo.example.com', site_id: SITE },
];

function json(obj) { return { status: 200, contentType: 'application/json', body: JSON.stringify(obj) }; }

const calls = [];
async function routeApi(route, req) {
  const u = new URL(req.url());
  const p = u.pathname;
  calls.push(req.method() + ' ' + p);
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204 });
  if (p === '/api/sites') return route.fulfill(json({ sites: [{ id: SITE, url: 'https://demo.example.com', last_crawl_at: Date.now() - 3600_000 }] }));
  if (p === '/api/workbench/sites') return route.fulfill(json({ sites: [{ id: SITE, url: 'https://demo.example.com', last_crawl_at: Date.now() - 3600_000 }] }));
  if (/\/api\/sites\/[^/]+\/orphans$/.test(p)) return route.fulfill(json({ orphans: ORPHANS }));
  if (/\/api\/sites\/[^/]+\/orphans\/[^/]+\/candidates$/.test(p)) return route.fulfill(json({ orphan: { id: ORPHAN, slug: '/alpha', title: 'Alpha Post' }, candidates: CANDIDATES }));
  if (/\/api\/sites\/[^/]+\/recrawl$/.test(p)) return route.fulfill(json({ crawlId: 'crawl_test' }));
  if (p === '/api/pushes') return route.fulfill(json({ pushes: PUSHES }));
  if (p === '/api/errors/messages') return route.fulfill(json({ messages: { wp_auth_failed: { what: 'Auth failed' } } }));
  if (p === '/api/auth/me' || p === '/api/users/me') return route.fulfill(json({ id: 'u1', email: 'eikiyo@demo.test' }));
  if (p === '/api/workbench/since') return route.fulfill(json({ items: [] }));
  return route.fulfill(json({}));
}

const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail || '' }); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.route('**/api/**', routeApi);
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));
const cspErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && /content security policy|refused to (execute|apply|load)|unsafe-inline/i.test(m.text())) cspErrors.push(m.text()); });

// ── ORPHANS ──────────────────────────────────────────────────────────────
console.log('\n[orphans]');
await page.goto(`${ORIGIN}/app/orphans.html?siteId=${SITE}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="orphan-row-0"]', { timeout: 5000 }).catch(() => {});
const rowCount = await page.locator('[data-testid^="orphan-row-"]').count();
check('orphan rows render', rowCount === 2, `${rowCount} rows`);
const fixHref = await page.locator('[data-testid="orphan-row-0"] a').getAttribute('href').catch(() => null);
check('"Fix this" link carries siteId+orphanId', fixHref === `/app/insertion.html?siteId=${SITE}&orphanId=orph_1`, fixHref || 'null');
// dismiss banner — banner is display:none until GSC state resolves; force it
// visible so we exercise the REAL click handler wired in pages.js.
const hasBanner = await page.locator('#gsc-banner').count();
if (hasBanner) {
  await page.evaluate(() => { const b = document.getElementById('gsc-banner'); if (b) b.style.display = 'block'; });
  await page.locator('#dismiss-banner').click();
  const gone = (await page.locator('#gsc-banner').count()) === 0;
  check('dismiss-banner removes #gsc-banner', gone);
} else { check('dismiss-banner (no banner in markup — skipped)', true, 'no #gsc-banner'); }
// recrawl button → navigates to crawl.html
const hasRecrawl = await page.locator('#recrawl-btn').count();
if (hasRecrawl) {
  await Promise.all([
    page.waitForURL(/\/app\/crawl\.html\?siteId=.*crawlId=crawl_test/, { timeout: 5000 }).catch(() => {}),
    page.locator('#recrawl-btn').click(),
  ]);
  const onCrawl = /\/app\/crawl\.html/.test(page.url()) && /crawlId=crawl_test/.test(page.url());
  check('recrawl-btn → crawl.html?crawlId', onCrawl, page.url().replace(ORIGIN, ''));
} else { check('recrawl-btn present', false, 'no #recrawl-btn'); }

// ── INSERTION ────────────────────────────────────────────────────────────
console.log('\n[insertion]');
await page.goto(`${ORIGIN}/app/insertion.html?siteId=${SITE}&orphanId=${ORPHAN}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const stayedInsertion = /\/app\/insertion\.html/.test(page.url());
check('insertion stays (params present, no redirect)', stayedInsertion, page.url().replace(ORIGIN, ''));
const backHref = await page.locator('#back-link').getAttribute('href').catch(() => null);
check('back-link → orphans?siteId', backHref === `/app/orphans.html?siteId=${SITE}`, backHref || 'null');
const hasNext = await page.locator('#next-orphan').count();
if (hasNext) {
  await Promise.all([
    page.waitForURL(/orphanId=orph_2/, { timeout: 5000 }).catch(() => {}),
    page.locator('#next-orphan').click(),
  ]);
  check('next-orphan advances to orph_2', /orphanId=orph_2/.test(page.url()), page.url().replace(ORIGIN, ''));
} else { check('next-orphan present', false, 'no #next-orphan'); }

// ── INSERTION no-params redirect guard ────────────────────────────────────
console.log('\n[insertion guard]');
await page.goto(`${ORIGIN}/app/insertion.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
check('no-params insertion redirects to orphans', /\/app\/orphans\.html/.test(page.url()), page.url().replace(ORIGIN, ''));

// ── AUDIT label ('pushed' → Verifying) ─────────────────────────────────────
console.log('\n[audit]');
await page.goto(`${ORIGIN}/app/audit.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="audit-list"]', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600);
const auditText = await page.locator('[data-testid="audit-list"]').innerText().catch(() => '');
check("'pushed' push shows a verifying label", /verifying/i.test(auditText), JSON.stringify(auditText.slice(0, 120)));
check("'verified' push shows verified label", /verified/i.test(auditText));

// ── TOAST XSS (the real toast() must render its message as TEXT, never HTML) ─
console.log('\n[toast xss]');
// audit.html is still loaded → app-shell.js (window.recto.toast) is live.
const xssPayload = '<img src=x onerror="window.__rectoXss=1">New anchor: pwn';
await page.evaluate((m) => window.recto.toast(m), xssPayload);
await page.waitForSelector('[data-testid="toast-msg"]', { timeout: 3000 }).catch(() => {});
await page.waitForTimeout(400); // give an onerror handler time to fire if markup parsed
const xssFired = await page.evaluate(() => !!window.__rectoXss);
check('toast does NOT execute injected markup (no onerror)', xssFired === false, xssFired ? 'XSS FIRED' : 'clean');
const msgChildCount = await page.locator('[data-testid="toast-msg"]').evaluate((el) => el.childElementCount).catch(() => -1);
check('toast message has no child ELEMENTS (text node only)', msgChildCount === 0, `childElementCount=${msgChildCount}`);
const msgText = await page.locator('[data-testid="toast-msg"]').innerText().catch(() => '');
check('toast renders the payload verbatim as text', msgText.includes('<img') && msgText.includes('New anchor: pwn'), JSON.stringify(msgText.slice(0, 80)));

// ── global ─────────────────────────────────────────────────────────────────
console.log('\n[global]');
check('no CSP violations across all pages', cspErrors.length === 0, cspErrors.join(' | '));
check('no uncaught JS errors', jsErrors.length === 0, jsErrors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${failed.length === 0 ? 'ALL ' + results.length + ' PASS' : failed.length + '/' + results.length + ' FAILED'} ===`);
if (failed.length) { failed.forEach((f) => console.log('  FAIL ' + f.name + (f.detail ? ' — ' + f.detail : ''))); process.exit(1); }
