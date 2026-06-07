// Phase 1 live verification — drives the REAL rectoapp.com Quick wins guided
// spine with a valid session cookie. Reads the rendered DOM (not the API):
// the orphan, the source paragraph, the highlighted <mark> phrase, the
// Pick-other-text drawer, and keyboard skip. Screenshots each state.
// This is the verify-the-UI-not-the-API rule made operational for Phase 1.
import { chromium } from '@playwright/test';

const COOKIE = process.env.RECTO_SESSION;
const ORIGIN = process.env.RECTO_ORIGIN || 'https://rectoapp.com';
const SITE = process.env.RECTO_SITE || '01KTEXDJDRYV6TBTRYG0VQQ3NZ';
const DO_LINK = process.env.RECTO_DO_LINK === '1'; // mutates live WP — opt-in only

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.message || String(e)).slice(0, 200)));
page.on('response', (res) => { if (res.status() >= 400 && !/favicon|analytics|gtag|plausible/i.test(res.url())) httpErr.push(`${res.status()} ${res.url().slice(0, 90)}`); });

const out = {};
try {
  const url = `${ORIGIN}/app/quick-wins.html?siteId=${SITE}`;
  log('→ goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  out.landed = page.url();

  // Wait for one of the terminal states to surface.
  await page.waitForFunction(() => {
    const vis = (s) => { const e = document.querySelector(s); return e && !e.hidden; };
    return vis('[data-testid="qw-card"]') || vis('[data-testid="qw-done"]') || vis('[data-testid="qw-nosite"]') || /auth\.html/.test(location.href);
  }, { timeout: 20000 }).catch(() => {});

  if (/auth\.html/.test(page.url())) {
    out.state = 'BOUNCED-TO-AUTH (session cookie missing/expired — set RECTO_SESSION)';
  } else if (await page.locator('[data-testid="qw-nosite"]:not([hidden])').count()) {
    out.state = 'NO-SITE';
  } else if (await page.locator('[data-testid="qw-done"]:not([hidden])').count()) {
    out.state = 'DONE (no quick wins for this site)';
  } else if (await page.locator('[data-testid="qw-card"]:not([hidden])').count()) {
    out.state = 'CARD';
    out.count = (await page.locator('[data-testid="qw-count"]').innerText().catch(() => '')).trim();
    out.orphan = (await page.locator('[data-testid="qw-orphan-title"]').innerText().catch(() => '')).trim();
    out.source = (await page.locator('[data-testid="qw-source-title"]').innerText().catch(() => '')).trim();
    out.paragraph = (await page.locator('[data-testid="qw-paragraph"]').innerText().catch(() => '')).trim().slice(0, 220);
    out.markCount = await page.locator('[data-testid="qw-paragraph"] mark').count();
    out.mark = (await page.locator('[data-testid="qw-paragraph"] mark').first().innerText().catch(() => '')).trim();
    out.linkDisabled = await page.locator('[data-testid="qw-link"]').isDisabled().catch(() => null);
    out.dots = await page.locator('[data-testid="qw-dots"] .qw__dot').count();
    await page.screenshot({ path: 'live-shots/quickwins-card.png', fullPage: true }).catch(() => {});

    // Exercise "Pick other text" → drawer should load source prose.
    await page.locator('[data-testid="qw-pick"]').click().catch(() => {});
    await page.waitForTimeout(2500);
    out.pickVisible = await page.locator('[data-testid="qw-pickwrap"]:not([hidden])').count() > 0;
    out.pickBody = (await page.locator('[data-testid="qw-pickbody"]').innerText().catch(() => '')).trim().slice(0, 120);
    await page.screenshot({ path: 'live-shots/quickwins-pick.png', fullPage: true }).catch(() => {});
    await page.locator('[data-testid="qw-pick-cancel"]').click().catch(() => {});
    await page.waitForTimeout(400);

    // Keyboard skip (S) → count should advance.
    const before = out.count;
    await page.keyboard.press('s');
    await page.waitForTimeout(2500);
    out.countAfterSkip = (await page.locator('[data-testid="qw-count"]').innerText().catch(() => '')).trim();
    out.skipAdvanced = before !== out.countAfterSkip;

    if (DO_LINK) {
      const c0 = (await page.locator('[data-testid="qw-count"]').innerText().catch(() => '')).trim();
      await page.locator('[data-testid="qw-link"]').click().catch(() => {});
      await page.waitForTimeout(3000);
      out.linkResult = (await page.locator('[data-testid="qw-count"]').innerText().catch(() => '')).trim();
      out.linkAdvanced = c0 !== out.linkResult;
      out.linkError = (await page.locator('[data-testid="qw-error"]:not([hidden])').innerText().catch(() => '')).trim();
    }
  } else {
    out.state = 'UNKNOWN — no terminal state visible';
    out.bodyLen = (await page.locator('body').innerText().catch(() => '')).length;
  }
} catch (e) {
  out.fatal = (e.message || String(e)).slice(0, 200);
}
out.consoleErrors = errors;
out.httpErrors = httpErr;
await browser.close();

log('\n================ QUICK WINS LIVE VERIFY ================');
log(JSON.stringify(out, null, 2));
