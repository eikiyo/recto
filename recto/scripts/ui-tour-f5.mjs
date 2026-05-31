// F5 simulation evidence: audit page after push verified + the live WP post
// with the freshly inserted anchor highlighted.

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'fs';

const SPA = 'http://localhost:8765';
const WP = 'http://localhost:8088';
const OUT_DIR = process.argv[2] || 'artifacts/ui-tour';

mkdirSync(OUT_DIR, { recursive: true });

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

(async () => {
  const cookies = readCookies('/tmp/eikiyo.cookies');
  const session = cookies.find((c) => c.name === 'recto_session');
  if (!session) throw new Error('No session cookie');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: session.name, value: session.value, url: 'http://localhost:8787' }]);
  const page = await ctx.newPage();

  // 1. Audit page (now has one verified row).
  await page.goto(`${SPA}/app/audit.html`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT_DIR}/11-audit-after-push.png`, fullPage: true });
  console.log('  ✓ 11-audit-after-push  audit log with one verified row');

  // 2. Live WP post — read mode (what a visitor sees).
  await page.goto(`${WP}/pre-seed-math/`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  // Highlight the recto-inserted anchor for evidence.
  await page.evaluate(() => {
    const a = document.querySelector('a[data-recto-link="1"]');
    if (a) {
      a.style.background = 'yellow';
      a.style.padding = '2px 4px';
      a.style.fontWeight = 'bold';
      a.style.outline = '2px solid #d97706';
      a.scrollIntoView({ block: 'center' });
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/12-wp-post-with-anchor.png`, fullPage: true });
  console.log('  ✓ 12-wp-post-with-anchor  live WP post, recto anchor highlighted');

  // 3. Same page zoomed to the inserted paragraph only.
  const anchor = await page.$('a[data-recto-link="1"]');
  if (anchor) {
    const paragraph = await anchor.evaluateHandle((el) => el.closest('p, .entry-content > *'));
    if (paragraph) {
      await paragraph.asElement()?.screenshot({ path: `${OUT_DIR}/13-wp-paragraph-zoom.png` });
      console.log('  ✓ 13-wp-paragraph-zoom  tight crop on the inserted anchor');
    }
  }

  await browser.close();
  console.log('\nDONE → ' + OUT_DIR);
})().catch((e) => { console.error(e); process.exit(1); });
