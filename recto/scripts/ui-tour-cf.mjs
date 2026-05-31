// Production tour against the deployed Cloudflare resources.
//   SPA: https://recto-ui.pages.dev
//   API: https://recto-api.syedmosayebalam.workers.dev
//
// Cookies sourced from /tmp/prod-cookies.txt (set by the smoke auth flow).
// This tour validates that the deployed worker + Pages site can render every
// SPA page against a real session, and surfaces any API error from prod.

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';

const SPA = process.env.RECTO_SPA || 'https://recto-ui.pages.dev';
const API = process.env.RECTO_API || 'https://recto-api.syedmosayebalam.workers.dev';
const OUT = process.argv[2] || 'artifacts/ui-tour-cf';

mkdirSync(OUT, { recursive: true });

function readCookies(path) {
  const text = readFileSync(path, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_')) || line.startsWith('\n')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    out.push({ name: parts[5], value: parts[6] });
  }
  return out;
}

(async () => {
  const cookies = readCookies('/tmp/prod-cookies.txt');
  const session = cookies.find((c) => c.name === 'recto_session');
  if (!session) throw new Error('No recto_session cookie in /tmp/prod-cookies.txt');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // Cross-site session (pages.dev → workers.dev) needs SameSite=None.
  await ctx.addCookies([{
    name: session.name,
    value: session.value,
    domain: new URL(API).hostname,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
  }]);
  const page = await ctx.newPage();

  const apiErrors = [];
  page.on('pageerror', (e) => apiErrors.push('pageerror: ' + e.message));
  page.on('response', (res) => {
    if (res.url().startsWith(API) && res.url().includes('/api/') && res.status() >= 400) {
      apiErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  async function shot(name, label, opts = {}) {
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(opts.delay || 1000);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    console.log(`  ✓ ${name}  ${label}`);
  }

  console.log('CF tour | SPA', SPA, '| API', API);

  await page.goto(`${SPA}/`);
  await shot('c01-landing', 'marketing landing');

  await page.goto(`${SPA}/app/auth.html`);
  await shot('c02-auth', 'sign-in form');

  await page.goto(`${SPA}/app/workbench.html`);
  await shot('c03-workbench', 'workbench — auth gated');

  await page.goto(`${SPA}/app/audit.html`);
  await shot('c04-audit', 'audit log');

  await page.goto(`${SPA}/app/settings-byok.html`);
  await shot('c05-settings', 'settings');

  await page.goto(`${SPA}/app/sites-new.html`);
  await shot('c06-sites-new', 'add-site form');

  writeFileSync(`${OUT}/_meta.json`, JSON.stringify({ spa: SPA, api: API, apiErrors, ts: new Date().toISOString() }, null, 2));

  await browser.close();
  console.log(`\nDONE → ${OUT}`);
  if (apiErrors.length) {
    console.log('\nAPI ERRORS:');
    apiErrors.forEach((e) => console.log('  ', e));
    process.exit(2);
  }
})().catch((e) => { console.error(e); process.exit(1); });
