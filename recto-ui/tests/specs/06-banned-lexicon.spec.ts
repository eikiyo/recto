import { test, expect } from '@playwright/test';

// Voice enforcer — banned lexicon per BRAND-VOICE.md §4 must not appear on any rendered page.
// Soft-banned terms are not enforced here (some have legitimate uses).

const HARD_BANNED = [
  'supercharge', 'unleash', 'revolutionize', 'game-changer', 'game changer',
  '10x', 'effortless', 'seamless', 'magical',
  'AI-powered', 'next-gen', 'cutting-edge', 'state-of-the-art', 'world-class',
  'best-in-class', 'synergy', 'crush it', 'level up',
  'turbocharge', 'holistic',
];

const PHRASE_BANNED = [
  'Oops', "something went wrong", 'Please try again later',
  "I'd be happy to", "Let's get started", "you'll love",
  "don't hesitate to reach out", "I hope this finds you well",
  'Get Started', 'Sign Up Now',
];

const pages = [
  '/', '/screens.html',
  '/app/auth.html', '/app/sites-new.html', '/app/setup-summary.html',
  '/app/gsc-connect.html', '/app/crawl.html', '/app/workbench.html',
  '/app/orphans.html', '/app/insertion.html', '/app/audit.html',
  '/app/gaps.html', '/app/settings-byok.html', '/emails/index.html',
];

for (const path of pages) {
  test(`banned lexicon :: ${path}`, async ({ page }) => {
    await page.goto(path);
    const body = (await page.locator('body').innerText()).toLowerCase();
    const hits: string[] = [];
    for (const word of HARD_BANNED) {
      // word-boundary check to avoid false matches inside other words
      const re = new RegExp(`(^|[^a-z0-9])${word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').toLowerCase()}([^a-z0-9]|$)`, 'i');
      if (re.test(body)) hits.push(word);
    }
    for (const phrase of PHRASE_BANNED) {
      if (body.includes(phrase.toLowerCase())) hits.push(phrase);
    }
    expect(hits, `banned terms on ${path}`).toEqual([]);
  });
}
