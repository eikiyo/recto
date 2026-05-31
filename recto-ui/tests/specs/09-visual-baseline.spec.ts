import { test, expect } from '@playwright/test';
import { loginAs, seedFixtureSite } from './helpers/auth';

// Visual baseline — generates screenshots on first run, asserts equality on
// subsequent runs. Tolerance is loose; this catches structural regressions,
// not pixel drift. Wired pages need auth; the spec authenticates first and
// uses the fixture site for orphans/insertion screens.

test(`visual :: landing-hero`, async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'chromium only');
  await page.goto('/');
  const el = page.locator('.hero').first();
  await el.waitFor();
  await expect(el).toHaveScreenshot('landing-hero.png', { maxDiffPixelRatio: 0.05 });
});

test(`visual :: workbench-since`, async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'chromium only');
  await loginAs(context);
  await page.goto('/app/workbench.html');
  const el = page.locator('[data-testid="since-block"]').first();
  await el.waitFor();
  await expect(el).toHaveScreenshot('workbench-since.png', { maxDiffPixelRatio: 0.05 });
});

test(`visual :: orphans-table`, async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'chromium only');
  await loginAs(context);
  const { siteId } = await seedFixtureSite();
  test.skip(!siteId, 'no fixture');
  await page.goto(`/app/orphans.html?siteId=${siteId}`);
  const el = page.locator('table').first();
  await el.waitFor();
  await expect(el).toHaveScreenshot('orphans-table.png', { maxDiffPixelRatio: 0.05 });
});

test(`visual :: insertion-paragraph`, async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'chromium only');
  await loginAs(context);
  const { siteId } = await seedFixtureSite();
  test.skip(!siteId, 'no fixture');
  const top = await context.request
    .get(`http://localhost:8787/api/sites/${siteId}/orphans?limit=1`)
    .then((r) => r.json())
    .then((d) => d.orphans?.[0]?.id);
  test.skip(!top, 'no orphan');
  await page.goto(`/app/insertion.html?siteId=${siteId}&orphanId=${top}`);
  const el = page.locator('.candidate--selected').first();
  await el.waitFor();
  await expect(el).toHaveScreenshot('insertion-paragraph.png', { maxDiffPixelRatio: 0.05 });
});
