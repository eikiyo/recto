// Phase 5 — FULL live journey verification. Walks the whole authenticated
// product through the REAL rectoapp.com UI with a valid session cookie, and
// (opt-in) performs a REAL end-to-end link push to live WordPress — the one
// assertion that proves the core value prop actually works, not just renders.
// Lesson: green tests != working product. See recto-core-product-shipped-broken.
import { chromium } from '@playwright/test';

const COOKIE = process.env.RECTO_SESSION;
const ORIGIN = process.env.RECTO_ORIGIN || 'https://rectoapp.com';
const SITE = process.env.RECTO_SITE || '01KTEXDJDRYV6TBTRYG0VQQ3NZ';
const DO_LINK = process.env.RECTO_DO_LINK === '1'; // mutates live WP — opt-in

const log = (...a) => console.log(...a);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (COOKIE) {
  await context.addCookies([{
    name: 'recto_session', value: COOKIE, domain: '.rectoapp.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
}
const page = await context.newPage();
const errors = [], httpErr = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.message || String(e)).slice(0, 160)));
page.on('response', (res) => { if (res.status() >= 400 && !/favicon|analytics|gtag|plausible|fonts/i.test(res.url())) httpErr.push(`${res.status()} ${res.url().slice(0, 80)}`); });

const txt = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')).trim();
const visible = async (sel) => (await page.locator(sel + ':not([hidden])').count().catch(() => 0)) > 0;
const journey = { steps: {} };

async function step(name, fn) {
  const before = errors.length, beforeH = httpErr.length;
  const s = {};
  try { await fn(s); } catch (e) { s.fatal = (e.message || String(e)).slice(0, 160); }
  s.newConsoleErrors = errors.slice(before);
  s.newHttpErrors = httpErr.slice(beforeH);
  s.clean = s.newConsoleErrors.length === 0 && s.newHttpErrors.length === 0 && !s.fatal;
  journey.steps[name] = s;
  log(`  ${s.clean ? 'OK  ' : 'WARN'} ${name}${s.fatal ? ' — ' + s.fatal : ''}`);
}

try {
  // 1 — WORKBENCH (home)
  await step('workbench', async (s) => {
    await page.goto(`${ORIGIN}/app/workbench.html?siteId=${SITE}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    s.landed = page.url();
    if (/auth/.test(page.url())) { s.state = 'BOUNCED-TO-AUTH'; return; }
    await page.waitForTimeout(2500);
    s.orphans = await txt('[data-testid="num-orphans"]');
    s.pages = await txt('[data-testid="num-pages"]');
    s.candidates = await txt('[data-testid="num-candidates"]');
    s.heroVisible = await visible('[data-testid="qw-hero"]');
    s.heroCount = await txt('[data-testid="qw-hero-count"]');
    await page.screenshot({ path: 'live-shots/journey-1-workbench.png', fullPage: true }).catch(() => {});
  });

  // 2 — QUICK WINS (the core: link an orphan with a verbatim phrase)
  await step('quick-wins', async (s) => {
    await page.goto(`${ORIGIN}/app/quick-wins.html?siteId=${SITE}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForFunction(() => {
      const vis = (x) => { const e = document.querySelector(x); return e && !e.hidden; };
      return vis('[data-testid="qw-card"]') || vis('[data-testid="qw-done"]') || vis('[data-testid="qw-nosite"]');
    }, { timeout: 20000 }).catch(() => {});
    s.card = await visible('[data-testid="qw-card"]');
    if (s.card) {
      s.count = await txt('[data-testid="qw-count"]');
      s.orphan = await txt('[data-testid="qw-orphan-title"]');
      s.markCount = await page.locator('[data-testid="qw-paragraph"] mark').count();
      s.mark = await txt('[data-testid="qw-paragraph"] mark');
      await page.screenshot({ path: 'live-shots/journey-2-quickwins.png', fullPage: true }).catch(() => {});

      if (DO_LINK) {
        const c0 = await txt('[data-testid="qw-count"]');
        await page.locator('[data-testid="qw-link"]').click().catch(() => {});
        await page.waitForTimeout(3500);
        s.countAfterLink = await txt('[data-testid="qw-count"]');
        s.linkAdvanced = c0 !== s.countAfterLink;
        s.linkError = await txt('[data-testid="qw-error"]:not([hidden])');
        s.realPush = s.linkAdvanced && !s.linkError;
        await page.screenshot({ path: 'live-shots/journey-2b-after-link.png', fullPage: true }).catch(() => {});
      }
    } else {
      s.terminal = (await visible('[data-testid="qw-done"]')) ? 'DONE' : (await visible('[data-testid="qw-nosite"]')) ? 'NO-SITE' : 'UNKNOWN';
    }
  });

  // 3 — AUDIT (the log of what was linked)
  await step('audit', async (s) => {
    await page.goto(`${ORIGIN}/app/audit.html?siteId=${SITE}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    s.legend = await visible('[data-testid="audit-legend"]');
    s.rows = await page.locator('[data-testid="audit-list"] > *').count().catch(() => 0);
    await page.screenshot({ path: 'live-shots/journey-3-audit.png', fullPage: true }).catch(() => {});
  });

  // 4 — SETTINGS (account + connections)
  await step('settings', async (s) => {
    await page.goto(`${ORIGIN}/app/settings-byok.html?siteId=${SITE}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    s.accountEmail = await txt('[data-testid="account-email"]');
    s.accountSites = await txt('[data-testid="account-sites"]');
    s.wpState = await txt('[data-testid="wp-state"]');
    await page.screenshot({ path: 'live-shots/journey-4-settings.png', fullPage: true }).catch(() => {});
  });
} catch (e) {
  journey.fatal = (e.message || String(e)).slice(0, 200);
}

await browser.close();
journey.allClean = Object.values(journey.steps).every((s) => s.clean);
log('\n================ FULL JOURNEY LIVE VERIFY ================');
log(JSON.stringify(journey, null, 2));
