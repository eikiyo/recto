// Phase 0 live bug-hunt — drives the REAL rectoapp.com UI with a valid session
// cookie, walks every app screen, and records console errors, page exceptions,
// failed requests, 4xx/5xx responses, and "stuck/empty" heuristics. This is the
// verify-the-UI-not-the-API rule made operational.
import { chromium } from '@playwright/test';

const COOKIE = process.env.RECTO_SESSION;
const SITE = '01KTEXDJDRYV6TBTRYG0VQQ3NZ';
const ORPHAN = '01KTEXJRGCYQNW7TF3QBY2QPF1';
const CRAWL = '01KTF4PRB173CS9CK8E0B0JQHQ';
const ORIGIN = 'https://rectoapp.com';

const routes = [
  { name: 'marketing-home', url: `${ORIGIN}/`, anon: true },
  { name: 'workbench', url: `${ORIGIN}/app/workbench.html` },
  { name: 'orphans', url: `${ORIGIN}/app/orphans.html?siteId=${SITE}` },
  { name: 'insertion', url: `${ORIGIN}/app/insertion.html?siteId=${SITE}&orphanId=${ORPHAN}` },
  { name: 'audit', url: `${ORIGIN}/app/audit.html` },
  { name: 'gaps', url: `${ORIGIN}/app/gaps.html?siteId=${SITE}` },
  { name: 'settings-byok', url: `${ORIGIN}/app/settings-byok.html` },
  { name: 'sites-new', url: `${ORIGIN}/app/sites-new.html` },
  { name: 'gsc-connect', url: `${ORIGIN}/app/gsc-connect.html?siteId=${SITE}` },
  { name: 'setup-summary', url: `${ORIGIN}/app/setup-summary.html?siteId=${SITE}` },
  { name: 'crawl', url: `${ORIGIN}/app/crawl.html?siteId=${SITE}&crawlId=${CRAWL}` },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (COOKIE) {
  await context.addCookies([{
    name: 'recto_session', value: COOKIE, domain: '.rectoapp.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
}

const report = [];
for (const r of routes) {
  const page = await context.newPage();
  const errors = [], failed = [], httpErr = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.message || String(e)).slice(0, 200)));
  page.on('requestfailed', (req) => failed.push(`${req.method()} ${req.url().slice(0, 90)} :: ${req.failure()?.errorText}`));
  page.on('response', (res) => { if (res.status() >= 400) httpErr.push(`${res.status()} ${res.url().slice(0, 90)}`); });

  let landed = r.url, stuck = '', textLen = 0, title = '';
  try {
    await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500); // let polls/SSE/render settle
    landed = page.url();
    title = await page.title().catch(() => '');
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    textLen = body.replace(/\s+/g, ' ').trim().length;
    // stuck/empty heuristics
    const low = body.toLowerCase();
    const stuckMarkers = ['loading', 'waiting for the first page', 'starting…', 'starting...'];
    if (textLen < 40) stuck = 'NEAR-EMPTY';
    else if (stuckMarkers.some((s) => low.includes(s)) && textLen < 400) stuck = 'POSSIBLY-STUCK: ' + low.slice(0, 80);
    // bounced to auth?
    if (!r.anon && /\/auth\.html|sign ?in/i.test(landed + ' ' + low) && r.name !== 'sites-new') {
      stuck = (stuck ? stuck + ' | ' : '') + 'BOUNCED-TO-AUTH';
    }
    await page.screenshot({ path: `live-shots/${r.name}.png`, fullPage: true }).catch(() => {});
  } catch (e) {
    stuck = 'NAV-FAILED: ' + (e.message || String(e)).slice(0, 120);
  }
  report.push({ name: r.name, landed: landed.replace(ORIGIN, ''), title: title.slice(0, 50), textLen, stuck, errors, failed: failed.filter((f) => !/favicon|analytics|gtag|plausible/i.test(f)), httpErr: httpErr.filter((h) => !/favicon|analytics|gtag|plausible/i.test(h)) });
  await page.close();
}
await browser.close();

console.log('\n================ LIVE BUG-HUNT REPORT ================\n');
for (const p of report) {
  const flags = [];
  if (p.stuck) flags.push('⚠ ' + p.stuck);
  if (p.errors.length) flags.push(`${p.errors.length} console-err`);
  if (p.failed.length) flags.push(`${p.failed.length} req-failed`);
  if (p.httpErr.length) flags.push(`${p.httpErr.length} http-4xx/5xx`);
  const status = flags.length ? '🐞 ' + flags.join(' · ') : '✅ clean';
  console.log(`[${p.name}] ${status}`);
  console.log(`   landed: ${p.landed}  | title: "${p.title}" | textLen: ${p.textLen}`);
  p.errors.slice(0, 4).forEach((e) => console.log(`   console: ${e}`));
  p.httpErr.slice(0, 4).forEach((e) => console.log(`   http: ${e}`));
  p.failed.slice(0, 3).forEach((e) => console.log(`   reqfail: ${e}`));
  console.log('');
}
