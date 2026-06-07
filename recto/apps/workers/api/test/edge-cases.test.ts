// Edge-case coverage for the failure modes listed in TRD §9 + the ones
// uncovered during D6-D10 build.
//
// Each test exercises the integration's classifier or error-message
// mapping rather than a full end-to-end run — keeps the suite fast and
// deterministic.

import { describe, it, expect } from 'vitest';
import { insertLink } from '../src/integrations/wordpress';
import { describe as describeErr } from '../src/lib/error-messages';
import { normalizeUrl } from '../src/routes/sites';

describe('site URL normalization — dedup the same site under cosmetic variants', () => {
  const canonical = 'https://site.com';
  it('collapses trailing slash, www, case, default port, query/hash to one form', () => {
    const variants = [
      'https://site.com',
      'https://site.com/',
      'https://www.site.com',
      'https://www.site.com/',
      'HTTPS://Site.com',
      'https://site.com:443',
      'https://site.com/?utm=x',
      'https://site.com/#top',
      '  https://site.com/  ',
    ];
    for (const v of variants) {
      expect(normalizeUrl(v)).toBe(canonical);
    }
  });
  it('keeps genuinely different sites distinct', () => {
    expect(normalizeUrl('https://site.com/blog')).toBe('https://site.com/blog');
    expect(normalizeUrl('http://site.com')).not.toBe(canonical); // scheme differs
    expect(normalizeUrl('https://other.com')).not.toBe(canonical);
  });
});

describe('WordPress insertLink — wrap an EXISTING phrase in place (core value prop)', () => {
  // signature: insertLink(original, anchorPhrase, href, scopeHint?)

  it('wraps the existing phrase in place — no new paragraph, no authored text', () => {
    const html = '<p>We compared cold brew methods for the best results.</p>';
    const { content, alreadyLinked, phraseNotFound, via } = insertLink(
      html,
      'cold brew methods',
      'https://x/cold-brew'
    );
    expect(alreadyLinked).toBe(false);
    expect(phraseNotFound).toBeFalsy();
    expect(via).toBe('wrap');
    // The phrase is now a link, and the rest of the paragraph is byte-identical.
    expect(content).toBe(
      '<p>We compared <a href="https://x/cold-brew" data-recto-link="1">cold brew methods</a> for the best results.</p>'
    );
    // Crucially: no extra <p> was appended.
    expect(content.match(/<p>/g)?.length).toBe(1);
  });

  it('does not change any of the blog’s words (only wraps)', () => {
    const html = '<p>The quick brown fox jumps over the lazy dog every morning.</p>';
    const { content } = insertLink(html, 'lazy dog', 'https://x/d');
    // Strip our anchor tags back out → must equal the original exactly.
    const stripped = content.replace(/<a [^>]*data-recto-link="1">(.*?)<\/a>/g, '$1');
    expect(stripped).toBe(html);
  });

  it('returns alreadyLinked when the target href is already present', () => {
    const html = '<p>Some prose. <a href="https://x/y">y</a></p>';
    const { content, alreadyLinked } = insertLink(html, 'Some prose', 'https://x/y');
    expect(alreadyLinked).toBe(true);
    expect(content).toBe(html);
  });

  it('adds a SECOND distinct link to a post that already holds another recto link (hub posts link many orphans)', () => {
    // A high-authority hub already links orphan /z. Linking a DIFFERENT orphan
    // /y from the same post must succeed — the old broad data-recto-link
    // short-circuit wrongly rejected this, capping a hub at one orphan ever.
    const html = '<p>Old content with <a data-recto-link="1" href="https://x/z">z</a>.</p>';
    const { content, alreadyLinked, phraseNotFound } = insertLink(html, 'Old content with', 'https://x/y');
    expect(alreadyLinked).toBe(false);
    expect(phraseNotFound).toBeFalsy();
    expect(content).toContain('href="https://x/y"');     // the new orphan's link landed
    expect(content).toContain('href="https://x/z"');     // the pre-existing link is untouched
  });

  it('still returns alreadyLinked when THIS orphan href is already present (per-href idempotency)', () => {
    const html = '<p>Old content with <a data-recto-link="1" href="https://x/y">y</a>.</p>';
    const { content, alreadyLinked } = insertLink(html, 'Old content with', 'https://x/y');
    expect(alreadyLinked).toBe(true);
    expect(content).toBe(html);
  });

  it('flags phraseNotFound and changes nothing when the phrase is absent (NEVER fabricates)', () => {
    const html = '<p>Different content entirely.</p>';
    const { content, alreadyLinked, phraseNotFound } = insertLink(html, 'not present here', 'https://x/y');
    expect(alreadyLinked).toBe(false);
    expect(phraseNotFound).toBe(true);
    expect(content).toBe(html); // untouched — the caller fails the push cleanly
  });

  it('never wraps a phrase that is already inside an <a>', () => {
    const html = '<p>See <a href="https://x/o">our coffee guide</a> for details.</p>';
    const { phraseNotFound, content } = insertLink(html, 'our coffee guide', 'https://x/y');
    expect(phraseNotFound).toBe(true);
    expect(content).toBe(html);
  });

  it('matches across whitespace/newlines in the HTML (WP wrapping)', () => {
    const html = '<p>brewing\n   great   coffee at home</p>';
    const { content, via } = insertLink(html, 'great coffee', 'https://x/g');
    expect(via).toBe('wrap');
    expect(content).toContain('data-recto-link="1"');
    // The matched run keeps its original internal whitespace.
    expect(content).toContain('>great   coffee<');
  });

  it('uses the scope hint to wrap the intended occurrence when the phrase repeats', () => {
    const html = '<p>coffee guide intro</p><p>read the coffee guide for tips</p>';
    const { content } = insertLink(html, 'coffee guide', 'https://x/g', 'read the coffee guide for tips');
    // Second occurrence wrapped, first left alone.
    expect(content).toBe(
      '<p>coffee guide intro</p><p>read the <a href="https://x/g" data-recto-link="1">coffee guide</a> for tips</p>'
    );
  });

  it('escapes href containing quotes', () => {
    const html = '<p>Marker phrase here.</p>';
    const { content } = insertLink(html, 'Marker phrase', 'https://x/"; alert(1)');
    expect(content).not.toContain('"; alert(1)');
    expect(content).toContain('&quot;');
  });
});

describe('error-messages — Wordfence, iThemes, host-blocked REST, GSC quota, slow magic link', () => {
  it('Wordfence + iThemes return the wp_security_blocked message', () => {
    const m = describeErr('wp_security_blocked');
    expect(m.what).toMatch(/Wordfence|firewall|blocked/i);
    expect(m.fix).toMatch(/Allow-list|JWT/i);
    expect(m.retryable).toBe(false);
  });

  it('host-blocked REST surfaces a distinct code', () => {
    const m = describeErr('wp_rest_disabled');
    expect(m.fix).toMatch(/wp-json|JWT/);
    expect(m.retryable).toBe(false);
  });

  it('GSC quota is retryable tomorrow', () => {
    const m = describeErr('gsc_quota_exceeded');
    expect(m.retryable).toBe(true);
    expect(m.fix).toMatch(/tomorrow|automatically/);
  });

  it('magic link expired is one-shot, user must request a new one', () => {
    const m = describeErr('magic_link_expired');
    expect(m.retryable).toBe(false);
    expect(m.fix).toMatch(/Request|new/);
  });

  it('unknown failure codes return a generic-but-actionable message', () => {
    const m = describeErr('completely_made_up_code');
    expect(m.what.length).toBeGreaterThan(0);
    expect(m.fix.length).toBeGreaterThan(0);
  });

  it('site-connect codes have named copy (no generic fallback)', () => {
    for (const code of [
      'wp_credentials_required',
      'webflow_key_required',
      'already_connected',
    ]) {
      const m = describeErr(code);
      // Must NOT be the generic fallback string.
      expect(m.what).not.toMatch(/did not recognize/i);
      expect(m.what.length).toBeGreaterThan(0);
      expect(m.fix.length).toBeGreaterThan(0);
    }
  });
});
