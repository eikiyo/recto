// Synthetic-persona gate. Three personas (Mira, Daniel, Sarah) each load the
// landing page and the workbench dashboard, and assert the visible copy:
//   1. Does not contain BRAND-VOICE §4 banned words
//   2. Does contain the persona's expected anchors (hook formula, sacred cow)
//   3. Renders the "without giving up" clause for at least Mira on the hero
//
// This catches surfaces that escape ESLint — anything inlined into HTML.

import { test, expect } from '@playwright/test';
import { HARD_BAN_WORDS, HOOK_ANTIPATTERNS } from '../packages/eslint-recto/src/banned-lexicon.js';

const HARD_RE = new RegExp(`\\b(?:${HARD_BAN_WORDS.join('|')})\\b`, 'i');

const PAGES = ['/', '/screens.html'];

const PERSONAS = [
  {
    name: 'Mira',
    must: ['without giving up the seat at the keyboard'],
  },
  {
    name: 'Daniel',
    must: [], // Daniel's hook lives on the AppSumo listing; landing is Mira-led
  },
  {
    name: 'Sarah',
    must: [],
  },
];

for (const persona of PERSONAS) {
  for (const route of PAGES) {
    test(`${persona.name} @ ${route} — no banned lexicon`, async ({ page }) => {
      await page.goto(route);
      const text = (await page.locator('body').innerText()).toLowerCase();

      const hit = HARD_RE.exec(text);
      expect(hit, `Banned word "${hit?.[0]}" found at ${route}`).toBeNull();

      for (const ap of HOOK_ANTIPATTERNS) {
        expect(ap.pattern.test(text), `Hook anti-pattern triggered at ${route}: ${ap.msg}`).toBe(false);
      }

      for (const phrase of persona.must) {
        expect(text).toContain(phrase.toLowerCase());
      }
    });
  }
}
