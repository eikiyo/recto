// FRESH full e2e — account was flushed, redo the whole journey through the
// REAL UI: connect site -> crawl -> workbench -> quick wins (real WP push) ->
// audit -> settings. Every assertion reads the rendered DOM. Real push (opt-in:
// set RECTO_SESSION + WP_* to run it; it no-ops without a session cookie).
import { chromium } from '@playwright/test';

const COOKIE = process.env.RECTO_SESSION;
const ORIGIN = process.env.RECTO_ORIGIN || 'https://rectoapp.com';
const WP_URL = process.env.WP_URL || 'https://your-wordpress-site.example';
const WP_USER = process.env.WP_USER || 'your-wp-user';
const WP_PASS = process.env.WP_PASS || '';

const log = (...a) => console.log(...a);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (COOKIE) await context.addCookies([{ name: 'recto_session', value: COOKIE, domain: '.rectoapp.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const page = await context.newPage();
const errors = [], httpErr = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push('PE: ' + (e.message || String(e)).slice(0, 160)));
page.on('response', (res) => { if (res.status() >= 400 && !/favicon|analytics|gtag|plausible|fonts/i.test(res.url())) httpErr.push(`${res.status()} ${res.url().slice(0, 80)}`); });

const txt = async (s) => (await page.locator(s).first().innerText().catch(() => '')).trim();
const vis = async (s) => (await page.locator(s + ':not([hidden])').count().catch(() => 0)) > 0;
const out = { steps: {} };
async function step(name, fn) {
  const b = errors.length, bh = httpErr.length; const s = {};
  try { await fn(s); } catch (e) { s.fatal = (e.message || String(e)).slice(0, 160); }
  s.newConsoleErrors = errors.slice(b); s.newHttpErrors = httpErr.slice(bh);
  s.clean = !s.fatal && s.newConsoleErrors.length === 0 && s.newHttpErrors.length === 0;
  out.steps[name] = s; log(`  ${s.clean ? 'OK  ' : 'WARN'} ${name}${s.fatal ? ' — ' + s.fatal : ''}`);
}

let siteId = '';
try {
  // 1 — CONNECT a site
  await step('connect', async (s) => {
    await page.goto(`${ORIGIN}/app/sites-new.html`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (/auth/.test(page.url())) { s.state = 'BOUNCED-TO-AUTH'; return; }
    await page.locator('[data-testid="cms-wp"]').check().catch(() => {});
    await page.locator('[data-testid="site-url"]').fill(WP_URL);
    await page.locator('[data-testid="wp-user"]').fill(WP_USER);
    await page.locator('[data-testid="wp-pass"]').fill(WP_PASS);
    await page.locator('[data-testid="connect-btn"]').click();
    // Lands on crawl.html?siteId=..&crawlId=..
    await page.waitForFunction(() => /crawl\.html|\/app\/crawl/.test(location.href) || document.querySelector('[data-testid="connect-err"]:not([hidden])'), { timeout: 30000 }).catch(() => {});
    s.landed = page.url();
    const m = page.url().match(/siteId=([^&]+)/); if (m) siteId = decodeURIComponent(m[1]);
    s.siteId = siteId;
    await page.screenshot({ path: 'live-shots/e2e-1-connect.png' }).catch(() => {});
  });

  // 2 — CRAWL completes (auto-redirects to workbench)
  await step('crawl', async (s) => {
    await page.waitForFunction(() => {
      const st = document.querySelector('[data-testid="crawl-status"]');
      return /workbench/.test(location.href) || (st && /complete/i.test(st.textContent || ''));
    }, { timeout: 240000 }).catch(() => {});
    s.status = await txt('[data-testid="crawl-status"]');
    s.progress = await txt('[data-testid="crawl-progress"]');
    s.url = page.url();
    await page.screenshot({ path: 'live-shots/e2e-2-crawl.png' }).catch(() => {});
  });

  // 3 — WORKBENCH: orphans surface (candidate gen may lag; retry)
  await step('workbench', async (s) => {
    let orphans = '0';
    for (let i = 0; i < 12; i++) {
      await page.goto(`${ORIGIN}/app/workbench.html?siteId=${siteId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(3000);
      orphans = await txt('[data-testid="num-orphans"]');
      if (orphans && orphans !== '0' && orphans !== '…') break;
    }
    s.orphans = orphans;
    s.pages = await txt('[data-testid="num-pages"]');
    s.candidates = await txt('[data-testid="num-candidates"]');
    s.heroVisible = await vis('[data-testid="qw-hero"]');
    await page.screenshot({ path: 'live-shots/e2e-3-workbench.png', fullPage: true }).catch(() => {});
  });

  // 4 — QUICK WINS: real push to live WP
  await step('quick-wins', async (s) => {
    let card = false;
    for (let i = 0; i < 10; i++) {
      await page.goto(`${ORIGIN}/app/quick-wins.html?siteId=${siteId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForFunction(() => {
        const v = (x) => { const e = document.querySelector(x); return e && !e.hidden; };
        return v('[data-testid="qw-card"]') || v('[data-testid="qw-done"]') || v('[data-testid="qw-nosite"]');
      }, { timeout: 20000 }).catch(() => {});
      card = await vis('[data-testid="qw-card"]');
      if (card) break;
      await page.waitForTimeout(6000); // candidates still generating
    }
    s.card = card;
    if (!card) { s.terminal = (await vis('[data-testid="qw-done"]')) ? 'DONE' : (await vis('[data-testid="qw-nosite"]')) ? 'NO-SITE' : 'UNKNOWN'; return; }
    s.count = await txt('[data-testid="qw-count"]');
    s.orphan = await txt('[data-testid="qw-orphan-title"]');
    s.markCount = await page.locator('[data-testid="qw-paragraph"] mark').count();
    s.mark = await txt('[data-testid="qw-paragraph"] mark');
    await page.screenshot({ path: 'live-shots/e2e-4-quickwins.png', fullPage: true }).catch(() => {});
    const c0 = s.count;
    await page.locator('[data-testid="qw-link"]').click().catch(() => {});
    await page.waitForTimeout(4000);
    s.countAfter = await txt('[data-testid="qw-count"]');
    s.linkAdvanced = c0 !== s.countAfter;
    s.linkError = await txt('[data-testid="qw-error"]:not([hidden])');
    s.realPush = s.linkAdvanced && !s.linkError;
    await page.screenshot({ path: 'live-shots/e2e-4b-after-push.png', fullPage: true }).catch(() => {});
  });

  // 5 — AUDIT
  await step('audit', async (s) => {
    await page.goto(`${ORIGIN}/app/audit.html?siteId=${siteId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    s.rows = await page.locator('[data-testid="audit-list"] > *').count().catch(() => 0);
    await page.screenshot({ path: 'live-shots/e2e-5-audit.png', fullPage: true }).catch(() => {});
  });

  // 6 — SETTINGS
  await step('settings', async (s) => {
    await page.goto(`${ORIGIN}/app/settings-byok.html?siteId=${siteId}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    s.accountEmail = await txt('[data-testid="account-email"]');
    s.accountSites = await txt('[data-testid="account-sites"]');
    s.wpState = await txt('[data-testid="wp-state"]');
    await page.screenshot({ path: 'live-shots/e2e-6-settings.png', fullPage: true }).catch(() => {});
  });
} catch (e) { out.fatal = (e.message || String(e)).slice(0, 200); }

await browser.close();
out.siteId = siteId;
out.allClean = Object.values(out.steps).every((s) => s.clean);
log('\n================ FRESH E2E LIVE VERIFY ================');
log(JSON.stringify(out, null, 2));
