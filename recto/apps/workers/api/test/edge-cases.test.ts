// Edge-case coverage for the failure modes listed in TRD §9 + the ones
// uncovered during D6-D10 build.
//
// Each test exercises the integration's classifier or error-message
// mapping rather than a full end-to-end run — keeps the suite fast and
// deterministic.

import { describe, it, expect } from 'vitest';
import { insertLink } from '../src/integrations/wordpress';
import { describe as describeErr } from '../src/lib/error-messages';

describe('WordPress insertLink — idempotency + safety', () => {
  it('returns alreadyLinked when the target href is already present', () => {
    const html = '<p>Some prose. <a href="https://x/y">y</a></p>';
    const { content, alreadyLinked } = insertLink(html, 'Some prose.', 'y', 'https://x/y');
    expect(alreadyLinked).toBe(true);
    expect(content).toBe(html);
  });

  it('returns alreadyLinked when data-recto-link marker is present anywhere', () => {
    const html = '<p>Old content with <a data-recto-link="1" href="https://x/z">z</a>.</p>';
    const { alreadyLinked } = insertLink(html, 'Old content with', 'irrelevant', 'https://x/y');
    expect(alreadyLinked).toBe(true);
  });

  it('inserts at the end of the marker paragraph when present', () => {
    const html = '<p>Source paragraph.</p>';
    const { content, alreadyLinked } = insertLink(html, 'Source paragraph.', 'related guide', 'https://x/g');
    expect(alreadyLinked).toBe(false);
    expect(content).toContain('data-recto-link="1"');
    expect(content).toContain('href="https://x/g"');
    expect(content).toContain('>related guide<');
  });

  it('falls back to first-paragraph insertion when the verbatim marker is missing', () => {
    // Strategy #3 (see insertLink docs): WP normalises whitespace/entities, so an
    // exact marker match often fails. Rather than no-op, insert a fresh paragraph
    // after the first </p> — still "in the body, near the top".
    const html = '<p>Different content.</p>';
    const { content, alreadyLinked, via, markerMissing } = insertLink(html, 'NOT-PRESENT', 'a', 'https://x/y');
    expect(alreadyLinked).toBe(false);
    expect(markerMissing).toBeFalsy();
    expect(via).toBe('first-paragraph');
    expect(content).toContain('<p>Different content.</p>'); // original preserved
    expect(content).toContain('href="https://x/y"');
    expect(content).toContain('data-recto-link="1"');
  });

  it('sets markerMissing when there is no paragraph break to land in', () => {
    // Strategy #4: no </p>, no WP block, no double-newline → nowhere safe to
    // insert, so flag markerMissing and leave content untouched (caller fails clean).
    const html = 'Plain text with no paragraph structure at all';
    const { content, alreadyLinked, markerMissing } = insertLink(html, 'NOT-PRESENT', 'a', 'https://x/y');
    expect(alreadyLinked).toBe(false);
    expect(markerMissing).toBe(true);
    expect(content).toBe(html);
  });

  it('escapes anchor text containing HTML special chars', () => {
    const html = '<p>Marker.</p>';
    const { content } = insertLink(html, 'Marker.', 'A & B <C>', 'https://x/y');
    expect(content).toContain('A &amp; B &lt;C&gt;');
    expect(content).not.toContain('<C>');
  });

  it('escapes href containing quotes', () => {
    const html = '<p>Marker.</p>';
    const { content } = insertLink(html, 'Marker.', 'anchor', 'https://x/"; alert(1)');
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
});
