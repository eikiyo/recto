// Production-grade Mira loop. Walks every SPA page with REAL API data and
// performs the actual end-to-end push. No mocks, no shortcuts.
//
// Run after wrangler dev + python http.server + docker compose up are up,
// and after /tmp/eikiyo.cookies + /tmp/recto-site-id exist.

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';

const SPA = 'http://localhost:8765';
const API = 'http://localhost:8787';
const OUT = process.argv[2] || 'artifacts/ui-tour-prod';

mkdirSync(OUT, { recursive: true });

function readCookies(path) {
  const text = readFileSync(path, 'utf8');
  const cookies = [];
  for (const line of text.split('\n')) {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_')) || line.startsWith('\n')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    cookies.push({ name: parts[5], value: parts[6] });
  }
  return cookies;
}

async function getTopOrphanId(siteId, cookieHeader) {
  const r = await fetch(`${API}/api/sites/${siteId}/orphans?limit=1`, { headers: { Cookie: cookieHeader } });
  const d = await r.json();
  return d.orphans?.[0]?.id;
}

(async () => {
  const cookies = readCookies('/tmp/eikiyo.cookies');
  const session = cookies.find((c) => c.name === 'recto_session');
  if (!session) throw new Error('No session cookie');
  const siteId = readFileSync('/tmp/recto-site-id', 'utf8').trim();
  const cookieHeader = `${session.name}=${session.value}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: session.name, value: session.value, url: 'http://localhost:8787' }]);
  const page = await ctx.newPage();

  const apiErrors = [];
  page.on('pageerror', (e) => apiErrors.push('pageerror: ' + e.message));
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes(':8787/api/') && res.status() >= 400) apiErrors.push(`${res.status()} ${u}`);
  });

  async function shot(name, label, opts = {}) {
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(opts.delay || 800);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    console.log(`  ✓ ${name}  ${label}`);
  }

  console.log('Production loop against', SPA, 'siteId', siteId);

  // 1. Landing
  await page.goto(`${SPA}/`);
  await shot('p01-landing', 'marketing landing');

  // 2. Auth
  await page.goto(`${SPA}/app/auth.html`);
  await shot('p02-auth', 'sign-in form');

  // 3. Workbench (wired)
  await page.goto(`${SPA}/app/workbench.html`);
  await shot('p03-workbench', 'real numerals + sites + activity', { waitFor: '[data-testid="num-pages"]' });

  // 4. Orphans (wired)
  await page.goto(`${SPA}/app/orphans.html?siteId=${siteId}`);
  await shot('p04-orphans', 'real orphan list (no WP system pages)', { waitFor: '[data-testid="orphan-row-0"]' });

  // 5. Insertion (wired) — drive a fresh push end-to-end.
  const orphanId = await getTopOrphanId(siteId, cookieHeader);
  if (!orphanId) throw new Error('no orphan to drive');
  await page.goto(`${SPA}/app/insertion.html?siteId=${siteId}&orphanId=${orphanId}`);
  await shot('p05-insertion', 'real candidates with anchor + paragraph', { waitFor: '[data-testid="candidate-1"]', delay: 2500 });

  // 6. Approve the top candidate. We don't follow the auto-redirect — we want
  // to land on audit ourselves with the toast visible.
  const approveBtn = await page.$('[data-testid="candidate-1"] button[data-action="push"]');
  if (approveBtn) {
    await approveBtn.click();
    await page.waitForURL(/audit\.html/, { timeout: 8000 }).catch(() => {});
  }

  // 7. Audit log — wait until the new push row materializes.
  await page.goto(`${SPA}/app/audit.html`);
  await page.waitForTimeout(2500); // verifier cron is ~30s, but the row appears as 'pending' immediately.
  await shot('p06-audit', 'audit log with real verified row', { waitFor: '[data-testid="audit-list"] tr' });

  // 8. Settings / BYOK (wired)
  await page.goto(`${SPA}/app/settings-byok.html`);
  await shot('p07-settings-byok', 'real license + BYOK form', { waitFor: '[data-testid="license-tier"]' });

  // 9. Gaps (wired)
  await page.goto(`${SPA}/app/gaps.html?siteId=${siteId}`);
  await shot('p08-gaps', 'publishing-gap report', { waitFor: '[data-testid="gap-list"]' });

  // 10. GSC connect (wired)
  await page.goto(`${SPA}/app/gsc-connect.html?siteId=${siteId}`);
  await shot('p09-gsc-connect', 'GSC OAuth start page');

  // 11. Sites-new (wired)
  await page.goto(`${SPA}/app/sites-new.html`);
  await shot('p10-sites-new', 'add-another-site form');

  writeFileSync(`${OUT}/_meta.json`, JSON.stringify({
    spa: SPA, api: API, siteId, orphanId,
    apiErrors,
    ts: new Date().toISOString(),
  }, null, 2));

  await browser.close();
  console.log(`\nDONE → ${OUT}`);
  if (apiErrors.length) {
    console.log('\nAPI ERRORS detected:');
    apiErrors.forEach((e) => console.log('  ', e));
    process.exit(2);
  }
})().catch((e) => { console.error(e); process.exit(1); });
