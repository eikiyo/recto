import { test, expect } from '@playwright/test';

// Anti-slop enforcer — visual contract per BRAND-TOOLKIT.md.

const BANNED_HEX = [
  '#6366f1',          // tech indigo (the slop)
  '#7c3aed', '#a78bfa', // purple family
  '#ffffff',          // pure white as ground (we use cream)
  '#10b981',          // mint
  '#facc15', '#fbbf24', // bright generic yellow
];

const BANNED_FONTS = ['Inter', 'Geist', 'Plus Jakarta Sans', 'Poppins', 'Roboto'];

const pages = [
  '/', '/screens.html',
  '/app/auth.html', '/app/sites-new.html', '/app/setup-summary.html',
  '/app/gsc-connect.html', '/app/crawl.html', '/app/workbench.html',
  '/app/orphans.html', '/app/insertion.html', '/app/audit.html',
  '/app/gaps.html', '/app/settings-byok.html', '/emails/index.html',
];

for (const path of pages) {
  test(`no box-shadow on visible elements :: ${path}`, async ({ page }) => {
    await page.goto(path);
    // ignore the focus-ring shadow on focused input — assert against non-focused state
    const shadows = await page.$$eval('*', (els) =>
      els
        .filter((el) => {
          const cs = getComputedStyle(el);
          const visible = cs.display !== 'none' && cs.visibility !== 'hidden';
          if (!visible) return false;
          const s = cs.boxShadow;
          if (!s || s === 'none') return false;
          // allow the focus-visible ring (only on :focus-visible at runtime)
          if (el.matches(':focus-visible')) return false;
          return true;
        })
        .map((el) => ({ tag: el.tagName, cls: el.className, shadow: getComputedStyle(el).boxShadow }))
    );
    expect(shadows, `box-shadow leaks on ${path}`).toEqual([]);
  });

  test(`no banned hex in computed styles :: ${path}`, async ({ page }) => {
    await page.goto(path);
    const hits = await page.evaluate((banned) => {
      const out: string[] = [];
      const norm = (v: string) => v.toLowerCase().replace(/\s+/g, '');
      const toHex = (rgb: string) => {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return rgb;
        const h = (n: string) => Number(n).toString(16).padStart(2, '0');
        return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toLowerCase();
      };
      const all = document.querySelectorAll('*');
      const props = ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor'];
      for (const el of all) {
        const cs = getComputedStyle(el as Element);
        for (const p of props) {
          const v = (cs as any)[p];
          if (!v) continue;
          const hex = toHex(v);
          for (const b of banned) if (norm(hex) === norm(b)) out.push(p + '=' + hex + ' on ' + el.tagName);
        }
      }
      return out.slice(0, 20);
    }, BANNED_HEX);
    expect(hits, `banned hex on ${path}`).toEqual([]);
  });

  test(`uses locked typography only :: ${path}`, async ({ page }) => {
    await page.goto(path);
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    for (const bf of BANNED_FONTS) {
      expect(body.toLowerCase(), `banned font on ${path}`).not.toContain(bf.toLowerCase());
    }
    // must include one of the locked families
    expect(body.toLowerCase()).toMatch(/(ibm plex sans|newsreader)/);
  });
}
