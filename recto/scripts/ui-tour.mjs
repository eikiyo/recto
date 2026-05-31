// Playwright UI tour. Walks every reachable SPA page with real data
// from the running wrangler dev + WP fixture, snapshots each to
// artifacts/ui-tour/. Reads the session cookie from /tmp/eikiyo.cookies.

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';

const SPA = 'http://localhost:8765';
const API = 'http://localhost:8787';
const OUT_DIR = process.argv[2] || 'artifacts/ui-tour';
const SITE_ID = readFileSync('/tmp/recto-site-id', 'utf8').trim();

mkdirSync(OUT_DIR, { recursive: true });

// Parse the Netscape-format cookies file dropped by `curl -c`.
function readCookies(path) {
  const text = readFileSync(path, 'utf8');
  const cookies = [];
  for (const line of text.split('\n')) {
    // `#HttpOnly_` is a legitimate cookie prefix in the Netscape format, not a comment.
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_')) || line.startsWith('\n')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    cookies.push({
      name: parts[5],
      value: parts[6],
      domain: parts[0].replace(/^#HttpOnly_/, ''),
      path: parts[2] || '/',
      expires: parts[4] ? Number(parts[4]) : -1,
      httpOnly: parts[0].startsWith('#HttpOnly_'),
      secure: parts[3] === 'TRUE',
      sameSite: 'Lax',
    });
  }
  return cookies;
}

async function getTopOrphanId() {
  const res = await fetch(`${API}/api/sites/${SITE_ID}/orphans?limit=1`, {
    headers: { Cookie: readCookies('/tmp/eikiyo.cookies').map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  const data = await res.json();
  return data.orphans?.[0]?.id;
}

async function shot(page, name, description) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`  ✓ ${name}  ${description ?? ''}`);
}

async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

(async () => {
  const cookies = readCookies('/tmp/eikiyo.cookies');
  if (!cookies.find((c) => c.name === 'recto_session')) {
    throw new Error('No recto_session cookie in /tmp/eikiyo.cookies — login first');
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  // Re-anchor the cookie to localhost so the SPA's CORS fetches carry it.
  await context.addCookies(
    cookies
      .filter((c) => c.name === 'recto_session')
      .map((c) => ({
        name: c.name,
        value: c.value,
        url: 'http://localhost:8787',
      }))
  );

  const page = await context.newPage();

  // Surface console errors so we see SPA bugs during the tour.
  page.on('pageerror', (e) => console.log('  ⚠ pageerror:', e.message));
  page.on('requestfailed', (req) => console.log(`  ⚠ requestfailed: ${req.url()} :: ${req.failure()?.errorText}`));

  console.log('UI tour against', SPA, 'site_id', SITE_ID);

  // 1. Landing page
  await page.goto(`${SPA}/`);
  await settle(page);
  await shot(page, '01-landing', 'marketing landing');

  // 2. Auth (form only — we already have a session)
  await page.goto(`${SPA}/app/auth.html`);
  await settle(page);
  await shot(page, '02-auth', 'sign-in form');

  // 3. Workbench (data: 3 numerals + sites row)
  await page.goto(`${SPA}/app/workbench.html`);
  await settle(page, 1500);
  await shot(page, '03-workbench', 'multi-site dashboard with real numbers');

  // 4. Orphans (the killer view — 40 orphans ranked)
  await page.goto(`${SPA}/app/orphans.html?siteId=${SITE_ID}`);
  await settle(page, 1500);
  await shot(page, '04-orphans', 'ranked orphan list, 40 entries');

  // 5. Insertion — pick top orphan
  const orphanId = await getTopOrphanId();
  if (orphanId) {
    await page.goto(`${SPA}/app/insertion.html?siteId=${SITE_ID}&orphanId=${orphanId}`);
    await settle(page, 5000); // candidate gen takes a moment
    await shot(page, '05-insertion', `candidates for orphan ${orphanId.slice(0, 8)}`);
  } else {
    console.log('  ⚠ no orphans found, skipping insertion screenshot');
  }

  // 6. Audit (will be empty — no pushes yet)
  await page.goto(`${SPA}/app/audit.html`);
  await settle(page);
  await shot(page, '06-audit-empty', 'audit log before push');

  // 7. Gaps
  await page.goto(`${SPA}/app/gaps.html?siteId=${SITE_ID}`);
  await settle(page);
  await shot(page, '07-gaps', 'publishing-gap report');

  // 8. Settings / BYOK
  await page.goto(`${SPA}/app/settings-byok.html`);
  await settle(page);
  await shot(page, '08-settings-byok', 'BYOK key form');

  // 9. GSC connect
  await page.goto(`${SPA}/app/gsc-connect.html?siteId=${SITE_ID}`);
  await settle(page);
  await shot(page, '09-gsc-connect', 'Google Search Console connect');

  // 10. Sites-new (state when adding another site)
  await page.goto(`${SPA}/app/sites-new.html`);
  await settle(page);
  await shot(page, '10-sites-new', 'add-another-site form');

  // Tour metadata
  writeFileSync(`${OUT_DIR}/_meta.json`, JSON.stringify({
    spa: SPA,
    api: API,
    siteId: SITE_ID,
    orphanId,
    ts: new Date().toISOString(),
  }, null, 2));

  await browser.close();
  console.log('\nDONE → ' + OUT_DIR);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
