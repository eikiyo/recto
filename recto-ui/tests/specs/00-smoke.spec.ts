import { test, expect } from '@playwright/test';

const pages = [
  '/',
  '/screens.html',
  '/app/auth.html',
  '/app/sites-new.html',
  '/app/setup-summary.html',
  '/app/gsc-connect.html',
  '/app/crawl.html',
  '/app/workbench.html',
  '/app/orphans.html',
  '/app/orphans.html?since=last',
  '/app/insertion.html',
  '/app/audit.html',
  '/app/gaps.html',
  '/app/settings-byok.html',
  '/emails/index.html',
];

for (const path of pages) {
  test(`200 + has title :: ${path}`, async ({ page }) => {
    const jsErrs: string[] = [];
    const local404: string[] = [];
    page.on('pageerror', (e) => jsErrs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) jsErrs.push(m.text()); });
    page.on('response', (r) => {
      const u = new URL(r.url());
      // The smoke suite runs unauthenticated against the live SPA. 401 from
      // the API on auth-gated endpoints (workbench/sites/users/me) is the
      // intended response — they're not errors, they're "please log in".
      // Only flag genuine 4xx/5xx on the SPA origin itself.
      if (u.port === '8787') return;
      if (u.host.includes('localhost') && r.status() >= 400) local404.push(r.status() + ' ' + r.url());
    });
    const resp = await page.goto(path);
    expect(resp?.status(), `status for ${path}`).toBeLessThan(400);
    await expect(page).toHaveTitle(/recto/i);
    expect(jsErrs, `JS errors on ${path}`).toEqual([]);
    expect(local404, `local 4xx on ${path}`).toEqual([]);
  });
}
