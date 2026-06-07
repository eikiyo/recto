// Phrase selection + matching — the guarantees behind "we only ever wrap text
// that already exists in the post, and never author anchor text."

import { describe, it, expect } from 'vitest';
import { isCleanPhrase, phraseInText, findPhrase, normalizePhrase } from '../src/lib/phrase';
import { deterministicPhrase } from '../src/integrations/anchor-select';

describe('phraseInText — verbatim substring check (whitespace-flexible)', () => {
  const body = 'We tested several   cold brew methods over a long weekend.';
  it('accepts an exact phrase regardless of whitespace/casing', () => {
    expect(phraseInText(body, 'cold brew methods')).toBe(true);
    expect(phraseInText(body, 'Cold Brew Methods')).toBe(true);
    expect(phraseInText(body, 'several cold brew')).toBe(true);
  });
  it('rejects phrases that are not present', () => {
    expect(phraseInText(body, 'pour over')).toBe(false);
    expect(phraseInText(body, 'brew cold methods')).toBe(false); // wrong order
    expect(phraseInText(null, 'anything')).toBe(false);
  });
});

describe('isCleanPhrase — selection guardrail', () => {
  it('accepts 2–8 plain word phrases', () => {
    expect(isCleanPhrase('cold brew methods')).toBe(true);
    expect(isCleanPhrase('the writer’s craft')).toBe(true); // curly apostrophe allowed
  });
  it('rejects one-word, too-long, or markup-bearing phrases', () => {
    expect(isCleanPhrase('coffee')).toBe(false); // single word
    expect(isCleanPhrase('a b c d e f g h i')).toBe(false); // too many words
    expect(isCleanPhrase('see <a href=x>here</a>')).toBe(false); // markup
    expect(isCleanPhrase('click (here)')).toBe(false); // brackets
  });
});

describe('findPhrase — locate a wrappable occurrence', () => {
  it('finds a plain occurrence and returns its exact matched text', () => {
    const html = '<p>brew great coffee at home</p>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    expect(hit!.matched).toBe('great coffee');
    expect(html.slice(hit!.start, hit!.end)).toBe('great coffee');
  });
  it('skips an occurrence already inside an anchor, finds a later free one', () => {
    const html = '<p><a href="z">great coffee</a> and more great coffee later</p>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    // Must be the SECOND occurrence (the free one), not the anchored first.
    expect(hit!.start).toBeGreaterThan(html.indexOf('</a>'));
  });
  it('returns null when the phrase only exists inside an anchor', () => {
    const html = '<p><a href="z">great coffee</a> only</p>';
    expect(findPhrase(html, 'great coffee')).toBeNull();
  });
  it('never matches across a tag boundary', () => {
    const html = '<p>great</p><p>coffee</p>';
    expect(findPhrase(html, 'great coffee')).toBeNull();
  });

  // Regression (2026-06-07): isInsideAnchor used lastIndexOf('<a', idx), which
  // matches "<article"/"<aside"/"<abbr"/"<address" — not just real <a> anchors.
  // A phrase preceded by one of those (with no real anchor between) was wrongly
  // skipped as "anchored", so the link was never inserted. These pin that a real
  // wrappable phrase IS found when only an <a>-prefixed NON-anchor precedes it.
  it('wraps a phrase that follows an <abbr> acronym (not a real anchor)', () => {
    const html = '<p>We love <abbr title="Search Engine Optimization">SEO</abbr> and great coffee at home.</p>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    expect(html.slice(hit!.start, hit!.end)).toBe('great coffee');
  });
  it('wraps a phrase inside an <article> wrapper', () => {
    const html = '<article><h1>Title</h1><p>brew great coffee here</p></article>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    expect(html.slice(hit!.start, hit!.end)).toBe('great coffee');
  });
  it('wraps a phrase that follows an <aside> block', () => {
    const html = '<aside class="note">Related reading</aside><p>great coffee starts here</p>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    expect(html.slice(hit!.start, hit!.end)).toBe('great coffee');
  });
  it('still skips a phrase genuinely inside a real <a> even when an <abbr> precedes it', () => {
    const html = '<p><abbr>SEO</abbr> <a href="z">great coffee</a> only</p>';
    expect(findPhrase(html, 'great coffee')).toBeNull();
  });
  it('finds the free occurrence after a real anchor, with an <abbr> in the mix', () => {
    const html = '<p><a href="z">great coffee</a> <abbr>SEO</abbr> then great coffee again</p>';
    const hit = findPhrase(html, 'great coffee');
    expect(hit).not.toBeNull();
    expect(hit!.start).toBeGreaterThan(html.indexOf('</a>'));
  });
});

describe('deterministicPhrase — fallback picks a real, relevant phrase', () => {
  it('returns a verbatim substring of the source body relevant to the target', () => {
    const sourceBody =
      'Our roastery notes explain how cold brew concentrate keeps for two weeks. ' +
      'We also cover espresso basics for beginners.';
    const out = deterministicPhrase({
      sourceBody,
      targetTitle: 'Cold Brew Concentrate Guide',
      targetH1: null,
      targetExcerpt: 'how to make and store cold brew concentrate',
    });
    expect(out).not.toBeNull();
    // Whatever it picks MUST already exist in the body, verbatim.
    expect(phraseInText(sourceBody, out!.phrase)).toBe(true);
    expect(out!.phrase.toLowerCase()).toContain('cold brew');
  });
  it('returns null when nothing in the body overlaps the target', () => {
    const out = deterministicPhrase({
      sourceBody: 'A short note about gardening tools and soil.',
      targetTitle: 'Quantum Cryptography Primer',
      targetH1: null,
      targetExcerpt: 'lattice based post quantum key exchange',
    });
    expect(out).toBeNull();
  });
});

describe('normalizePhrase', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePhrase('  a   b\n c ')).toBe('a b c');
  });
});
