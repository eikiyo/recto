// Property-based tests using fast-check. Targets correctness invariants
// rather than specific examples.
//
// Crypto props rely on the Web Crypto polyfill present in Node 20+.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { encrypt, decrypt, sign, verify, hashToken } from '../src/lib/crypto';
import { insertLink } from '../src/integrations/wordpress';

const KEK = 'MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY='; // 32-byte b64
const HMAC_SECRET = 'integration-suite-secret-do-not-ship-this-string';

describe('crypto round-trip properties', () => {
  it('encrypt(decrypt(x)) === x for arbitrary UTF-8 strings', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 4096, unit: 'binary' }), async (plain) => {
        const ct = await encrypt(plain, KEK);
        const back = await decrypt(ct, KEK);
        expect(back).toBe(plain);
      }),
      { numRuns: 60 }
    );
  });

  it('two encryptions of the same plaintext yield different ciphertexts (IV randomization)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 256, unit: 'binary' }), async (plain) => {
        const a = await encrypt(plain, KEK);
        const b = await encrypt(plain, KEK);
        const aBuf = Buffer.from(a);
        const bBuf = Buffer.from(b);
        expect(aBuf.equals(bBuf)).toBe(false);
      }),
      { numRuns: 30 }
    );
  });

  it('HMAC sign + verify accept legitimate pairs and reject forgeries', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 1024 }), async (msg) => {
        const sig = await sign(msg, HMAC_SECRET);
        expect(await verify(msg, sig, HMAC_SECRET)).toBe(true);
        // Flip one char in the message; signature must reject.
        const flippedMsg = msg + '!';
        expect(await verify(flippedMsg, sig, HMAC_SECRET)).toBe(false);
        // Flip a HIGH-order char in the signature (not the trailing char —
        // unpadded base64url's last char encodes only the leftover bits,
        // which may decode to the same byte sequence). Char 0 always
        // changes a meaningful byte.
        const flippedSig = (sig[0] === 'A' ? 'Z' : 'A') + sig.slice(1);
        expect(await verify(msg, flippedSig, HMAC_SECRET)).toBe(false);
      }),
      { numRuns: 50 }
    );
  });

  it('hashToken is deterministic and constant length (sha256 hex = 64 chars)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 512 }), async (tok) => {
        const h1 = await hashToken(tok);
        const h2 = await hashToken(tok);
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 40 }
    );
  });
});

describe('insertLink HTML-injection safety + idempotence', () => {
  // Anchor + href arbitraries that include dangerous chars so we can prove
  // escaping holds in all cases.
  const anchorArb = fc.stringMatching(/^[\p{L}\p{N} '"<>&]{1,40}$/u);
  const hrefArb = fc.stringMatching(/^https:\/\/[a-z0-9.\-_/?&"=#]{3,80}$/);

  it('output never contains literal "<script" regardless of input', () => {
    fc.assert(
      fc.property(anchorArb, hrefArb, (anchor, href) => {
        const html = '<p>Source paragraph.</p>';
        const { content } = insertLink(html, 'Source paragraph.', anchor, href);
        expect(content.toLowerCase()).not.toMatch(/<script/);
      }),
      { numRuns: 60 }
    );
  });

  it('inserting twice with the same target is idempotent', () => {
    fc.assert(
      fc.property(anchorArb, hrefArb, (anchor, href) => {
        const html = '<p>Source paragraph.</p>';
        const first = insertLink(html, 'Source paragraph.', anchor, href);
        if (first.alreadyLinked) return; // Triggered the alreadyLinked branch (e.g. dangerous href detected) — done.
        const second = insertLink(first.content, 'Source paragraph.', anchor, href);
        // Second call must either be alreadyLinked OR produce no further insertion.
        expect(second.alreadyLinked).toBe(true);
      }),
      { numRuns: 60 }
    );
  });

  it('href quote chars are escaped (no attribute-break vulnerability)', () => {
    const html = '<p>Marker.</p>';
    const evil = 'https://x/"; onclick="alert(1)';
    const { content } = insertLink(html, 'Marker.', 'anchor', evil);
    // The literal `"; onclick=` substring must not survive escaping.
    expect(content).not.toContain('"; onclick');
  });

  it('anchor text "<script>" comes out as &lt;script&gt; not <script>', () => {
    const html = '<p>Marker.</p>';
    const { content } = insertLink(html, 'Marker.', '<script>alert(1)</script>', 'https://x/y');
    expect(content).toContain('&lt;script&gt;');
    expect(content.toLowerCase()).not.toContain('<script>');
  });
});
