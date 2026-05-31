import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { loginAs, seedFixtureSite } from './helpers/auth';

// One-shot harness: full-page screenshots of every screen at desktop + mobile.
// Output: /tmp/recto-audit-screenshots/{desktop,mobile}/*.png
// Plus 4 interaction-state shots: insertion-after-focus, crawl-mid, audit-toast, gsc-banner.

const OUT = '/tmp/recto-audit-screenshots';
const D = path.join(OUT, 'desktop');
const M = path.join(OUT, 'mobile');
const I = path.join(OUT, 'interactions');
for (const d of [OUT, D, M, I]) fs.mkdirSync(d, { recursive: true });

const pages: Array<[string, string]> = [
  ['00-landing', '/'],
  ['01-screens-index', '/screens.html'],
  ['02-auth', '/app/auth.html'],
  ['03-sites-new', '/app/sites-new.html'],
  ['04-setup-summary', '/app/setup-summary.html'],
  ['05-gsc-connect', '/app/gsc-connect.html'],
  ['06-crawl', '/app/crawl.html'],
  ['07-workbench', '/app/workbench.html'],
  ['08-orphans', '/app/orphans.html'],
  ['09-orphans-filtered', '/app/orphans.html?since=last'],
  ['10-insertion', '/app/insertion.html'],
  ['11-audit', '/app/audit.html'],
  ['12-gaps', '/app/gaps.html'],
  ['13-settings-byok', '/app/settings-byok.html'],
  ['14-emails', '/emails/index.html'],
];

test.describe.configure({ mode: 'serial' });

test.describe('desktop shots @1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const [name, url] of pages) {
    test(`desktop :: ${name}`, async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(D, `${name}.png`), fullPage: true });
    });
  }
});

test.describe('mobile shots @390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  for (const [name, url] of pages) {
    test(`mobile :: ${name}`, async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(M, `${name}.png`), fullPage: true });
    });
  }
});

test.describe('interactions @1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('insertion view — anchor focused', async ({ page, context }) => {
    await loginAs(context);
    const { siteId } = await seedFixtureSite(context);
    test.skip(!siteId, 'no fixture');
    const top = await context.request
      .get(`http://localhost:8787/api/sites/${siteId}/orphans?limit=1`)
      .then((r) => r.json())
      .then((d) => d.orphans?.[0]?.id);
    test.skip(!top, 'no orphan');
    await page.goto(`/app/insertion.html?siteId=${siteId}&orphanId=${top}`, { waitUntil: 'networkidle' });
    await page.getByTestId('anchor-input').waitFor();
    await page.getByTestId('anchor-input').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(I, 'insertion-anchor-focused.png'), fullPage: true });
  });

  test('insertion view — pushed toast', async ({ page, context }) => {
    await loginAs(context);
    const { siteId } = await seedFixtureSite(context);
    test.skip(!siteId, 'no fixture');
    const top = await context.request
      .get(`http://localhost:8787/api/sites/${siteId}/orphans?limit=1`)
      .then((r) => r.json())
      .then((d) => d.orphans?.[0]?.id);
    test.skip(!top, 'no orphan');
    await page.goto(`/app/insertion.html?siteId=${siteId}&orphanId=${top}`, { waitUntil: 'networkidle' });
    await page.getByTestId('insert-btn').waitFor();
    await page.getByTestId('insert-btn').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(I, 'insertion-toast.png'), fullPage: false });
  });

  test('crawl mid-progress', async ({ page }) => {
    await page.goto('/app/crawl.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(I, 'crawl-mid.png'), fullPage: true });
  });

  test('orphans with GSC banner visible', async ({ page }) => {
    await page.goto('/app/orphans.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(I, 'orphans-with-banner.png'), fullPage: true });
  });

  test('sites-new with WP walkthrough expanded', async ({ page }) => {
    await page.goto('/app/sites-new.html', { waitUntil: 'networkidle' });
    await page.locator('details.accordion summary').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(I, 'sites-new-walkthrough-open.png'), fullPage: true });
  });
});
