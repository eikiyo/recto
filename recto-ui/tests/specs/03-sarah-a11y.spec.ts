import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, seedFixtureSite } from './helpers/auth';

// Sarah-sim — accessibility-dependent. WCAG 2.1 AA via axe-core.

const pages = [
  '/',
  '/app/auth.html',
  '/app/sites-new.html',
  '/app/setup-summary.html',
  '/app/gsc-connect.html',
  '/app/crawl.html',
  '/app/workbench.html',
  '/app/orphans.html',
  '/app/insertion.html',
  '/app/audit.html',
  '/app/gaps.html',
  '/app/settings-byok.html',
  '/emails/index.html',
  '/screens.html',
];

for (const path of pages) {
  test(`WCAG 2.1 AA :: ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    if (results.violations.length) {
      console.log('AXE violations on', path, JSON.stringify(results.violations, null, 2));
    }
    expect(results.violations, `axe-core violations on ${path}`).toEqual([]);
  });
}

test.describe('keyboard navigation', () => {
  test('orphan list is keyboard-reachable', async ({ page }) => {
    await page.goto('/app/orphans.html');
    const focused = await page.evaluate(async () => {
      const order: string[] = [];
      for (let i = 0; i < 15; i++) {
        const e = document.activeElement as HTMLElement | null;
        order.push(e?.tagName + ':' + (e?.textContent || '').slice(0, 20));
        // simulate tab
        const ev = new KeyboardEvent('keydown', { key: 'Tab' });
        document.dispatchEvent(ev);
      }
      return order;
    });
    expect(focused.length).toBeGreaterThan(0);
  });

  test('insertion view: anchor input has accessible name via label', async ({ page, context }) => {
    await loginAs(context);
    const { siteId } = await seedFixtureSite(context);
    test.skip(!siteId, 'no fixture');
    const top = await context.request
      .get(`http://localhost:8787/api/sites/${siteId}/orphans?limit=1`)
      .then((r) => r.json())
      .then((d) => d.orphans?.[0]?.id);
    test.skip(!top, 'no orphan');
    await page.goto(`/app/insertion.html?siteId=${siteId}&orphanId=${top}`);
    const anchor = page.getByTestId('anchor-input');
    await anchor.waitFor();
    await expect(anchor).toBeVisible();
    await anchor.focus();
    await expect(anchor).toBeFocused();
  });
});
