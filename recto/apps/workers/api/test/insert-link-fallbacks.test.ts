import { describe, expect, it } from 'vitest';
import { insertLink } from '../src/integrations/wordpress';

describe('WordPress insertLink - fallback branches', () => {
  it('leaves empty content untouched and reports phraseNotFound', () => {
    const result = insertLink('', 'missing phrase', 'https://x/missing');

    expect(result).toEqual({
      content: '',
      alreadyLinked: false,
      phraseNotFound: true,
    });
  });

  it('wraps a free phrase even when the content has no paragraph break', () => {
    const html = 'Intro sentence with target phrase and no block tags.';
    const result = insertLink(html, 'target phrase', 'https://x/target');

    expect(result.alreadyLinked).toBe(false);
    expect(result.phraseNotFound).toBeFalsy();
    expect(result.via).toBe('wrap');
    expect(result.content).toBe(
      'Intro sentence with <a href="https://x/target" data-recto-link="1">target phrase</a> and no block tags.'
    );
  });

  it('does not require a pre-existing recto marker to wrap a matching phrase', () => {
    const html = '<p>A clean paragraph mentions internal link coverage.</p>';
    const result = insertLink(html, 'internal link coverage', 'https://x/coverage');

    expect(html).not.toContain('data-recto-link="1"');
    expect(result.content).toBe(
      '<p>A clean paragraph mentions <a href="https://x/coverage" data-recto-link="1">internal link coverage</a>.</p>'
    );
  });

  it('keeps an unrelated recto marker while adding the requested href', () => {
    const html =
      '<p><a data-recto-link="1" href="https://x/existing">Existing link</a> plus fresh target phrase.</p>';
    const result = insertLink(html, 'fresh target phrase', 'https://x/fresh');

    expect(result.alreadyLinked).toBe(false);
    expect(result.phraseNotFound).toBeFalsy();
    expect(result.content).toContain('href="https://x/existing"');
    expect(result.content).toContain(
      '<a href="https://x/fresh" data-recto-link="1">fresh target phrase</a>'
    );
  });
});
