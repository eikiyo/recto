import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth';

// Mira-sim — impatient power user. Validates the wired Journey 1 against
// the live API + SPA. Each test seeds its own session so they can run
// in parallel without state leakage between workers.

test.describe('Mira-sim — Journey 1 happy path', () => {
  test('marketing → sign in CTA → auth gate (connect requires auth)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('hero-phrase')).toContainText('Recover the traffic your site forgot.');
    await expect(page.getByTestId('hero-phrase')).toContainText('Without giving up the seat at the keyboard.');

    await page.getByTestId('cta-connect').click();
    // The CTA used to deep-link directly to /app/sites-new.html which let
    // unauthenticated visitors see a connect form they couldn't actually
    // submit. We now route through auth so the funnel is honest.
    await expect(page).toHaveURL(/\/app\/auth\.html$/);
    const email = page.getByTestId('email-input');
    await expect(email).toHaveValue('');
    await expect(email).toHaveAttribute('placeholder', /you@/);
  });

  test('crawl page advertises async behaviour the user can rely on', async ({ page }) => {
    await page.goto('/app/crawl.html');
    await expect(page.locator('body')).toContainText('You can close this tab. We will email you when done.');
  });

  test('orphans page has no stub filter dropdown', async ({ page, context }) => {
    const { seedFixtureSite } = await import('./helpers/auth');
    await loginAs(context);
    const { siteId } = await seedFixtureSite();
    test.skip(!siteId, 'no fixture — orphans page is auth-gated to a site');
    await page.goto(`/app/orphans.html?siteId=${siteId}`);
    // The orphans page used to ship a Filter ▾ dropdown with three menu
    // items whose data-filter attributes were never honored by pageOrphans.
    // Pure stub — removed. Pin that fact.
    await expect(page.getByTestId('filter-menu')).toHaveCount(0);
    await expect(page.getByTestId('recrawl-btn')).toBeVisible();
  });
});
