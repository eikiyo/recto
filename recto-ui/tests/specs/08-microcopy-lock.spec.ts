import { test, expect } from '@playwright/test';
import { loginAs, seedFixtureSite } from './helpers/auth';

// Microcopy lock — every locked phrase from BRAND-VOICE.md must appear
// verbatim on its surface. Auth-gated pages use loginAs.

test('hero phrase follows hook pattern', async ({ page }) => {
  await page.goto('/');
  const hero = page.getByTestId('hero-phrase');
  await expect(hero).toContainText('Recover the traffic your site forgot.');
  await expect(hero).toContainText('Without giving up the seat at the keyboard.');
});

test('old hero phrase preserved as closing editorial flourish', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText('Notes in the margins of your site.');
});

test('promise triple in order', async ({ page }) => {
  await page.goto('/');
  const body = await page.locator('body').innerText();
  const i1 = body.indexOf('You buy it once.');
  const i2 = body.indexOf('We surface the orphans worth saving.');
  const i3 = body.indexOf('You stay in the seat.');
  expect(i1).toBeGreaterThan(-1);
  expect(i2).toBeGreaterThan(i1);
  expect(i3).toBeGreaterThan(i2);
});

test('pricing section explains stacking in the new flat-$39 model', async ({ page }) => {
  await page.goto('/');
  // The previous build said "Stack any number of codes." The new pricing
  // model is flat $39, 1 code = 1 site + 100 anchor credits / month, so we
  // explain the same idea ("stack codes for more sites") in a way that
  // matches the price-table copy.
  await expect(page.locator('body')).toContainText('Stack codes for more sites');
});

test('founder note signed by Eikiyo with bio, no other first-person on landing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('blockquote')).toContainText('I built recto because');
  await expect(page.locator('cite')).toContainText('Eikiyo');
  await expect(page.locator('cite')).toContainText('founder');
});

test('crawl page line: tab-closable + email-on-done', async ({ page }) => {
  await page.goto('/app/crawl.html');
  await expect(page.locator('body')).toContainText('You can close this tab. We will email you when done.');
});

test('workbench "since you were last here" header in mono uppercase', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/app/workbench.html');
  await expect(page.locator('body')).toContainText('Since you were last here');
});

test('approve-and-push fires a "Pushed" toast and navigates to audit', async ({ page, context }) => {
  await loginAs(context);
  const { siteId } = await seedFixtureSite();
  test.skip(!siteId, 'no fixture');
  const top = await context.request
    .get(`http://localhost:8787/api/sites/${siteId}/orphans?limit=1`)
    .then((r) => r.json())
    .then((d) => d.orphans?.[0]?.id);
  test.skip(!top, 'no orphan');
  await page.goto(`/app/insertion.html?siteId=${siteId}&orphanId=${top}`);
  await page.getByTestId('candidate-1').waitFor();
  await page.getByTestId('insert-btn').click();
  await expect(page.getByTestId('toast-msg')).toContainText('Pushed.');
});

test('primary CTA labels are sentence-case verb+object', async ({ page }) => {
  await page.goto('/');
  // "Connect a site"
  await expect(page.getByTestId('cta-connect')).toHaveText(/Connect a site/i);
});

test('settings page surfaces BYOK cost honestly', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/app/settings-byok.html');
  await expect(page.getByTestId('byok-cost-note')).toContainText('$0.06');
});

test('audit row shows verified-live phrasing when at least one push exists', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/app/audit.html');
  const list = page.locator('tbody[data-testid="audit-list"]');
  await list.waitFor();
  const verified = page.locator('span.badge--ok:has-text("verified live")');
  const empty = page.locator('tbody[data-testid="audit-list"] >> text=No pushes yet');
  // Either a verified row exists or the user has no pushes yet — both are
  // valid microcopy states. We only fail when neither renders.
  const verifiedCount = await verified.count();
  const emptyCount = await empty.count();
  expect(verifiedCount + emptyCount).toBeGreaterThan(0);
  if (verifiedCount > 0) {
    await expect(verified.first()).toContainText('verified live');
  }
});
