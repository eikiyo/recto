// HTML extractor — runs against an HTML Response using HTMLRewriter (native to
// Workers, zero deps, streaming). Single pass extracts:
//   - <title>
//   - first <h1>
//   - body text (capped at MAX_TEXT chars; tags ignored)
//   - all <a href> on the page
//
// We do NOT execute scripts. For JS-required sites the caller falls back to
// the Browser Rendering binding (D3.1.5).

import { normalizeUrl, sameOrigin } from './url-norm';

const MAX_TEXT = 8000; // ~1000 words ceiling per FR-CRAWL-03

export type Extracted = {
  title: string;
  h1: string;
  excerpt: string; // first MAX_TEXT chars of visible body text
  internalAnchors: { href: string; text: string }[];
};

export async function extract(html: Response, pageUrl: string): Promise<Extracted> {
  let title = '';
  let h1 = '';
  const textChunks: string[] = [];
  let textLen = 0;
  const anchorsCollecting: { href: string; text: string }[] = [];

  // Capture nested state without classes: HTMLRewriter handlers are called
  // for element/text events; we hold cursors in closures.
  let inTitle = false;
  let inH1 = false;
  let inScript = false;
  let inStyle = false;
  let inNav = false;
  let inFooter = false;
  let inAside = 0; // depth counter — asides can nest
  let inAnchor: { href: string; text: string } | null = null;

  const rewriter = new HTMLRewriter()
    .on('script, style', {
      element(el) {
        // Capture tagName synchronously — the el token is invalid inside onEndTag.
        const tag = el.tagName;
        if (tag === 'script') inScript = true;
        else inStyle = true;
        el.onEndTag(() => {
          if (tag === 'script') inScript = false;
          else inStyle = false;
        });
      },
    })
    .on('nav', {
      element(el) {
        inNav = true;
        el.onEndTag(() => {
          inNav = false;
        });
      },
    })
    .on('footer', {
      element(el) {
        inFooter = true;
        el.onEndTag(() => {
          inFooter = false;
        });
      },
    })
    // Sidebar widgets ("Recent Posts", category list, archive) live in <aside>
    // and in elements with class="widget"/"sidebar". Without skipping them
    // every WP post would have inbound links from every other post via the
    // sidebar — orphan detection would always return zero.
    .on('aside, .widget, .sidebar, [role="complementary"]', {
      element(el) {
        inAside += 1;
        el.onEndTag(() => {
          inAside = Math.max(0, inAside - 1);
        });
      },
    })
    .on('title', {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
      text(t) {
        if (inTitle) title += t.text;
      },
    })
    .on('h1', {
      element(el) {
        if (!h1) inH1 = true;
        el.onEndTag(() => {
          inH1 = false;
        });
      },
      text(t) {
        if (inH1) h1 += t.text;
      },
    })
    .on('a[href]', {
      element(el) {
        // Reject anchors inside nav/footer/aside/widget chrome — those are
        // template links (recent posts, breadcrumbs, archives), not
        // content-to-content edges. Counting them breaks orphan detection.
        if (inNav || inFooter || inAside > 0) return;
        const href = el.getAttribute('href') ?? '';
        const normalized = normalizeUrl(href, pageUrl);
        if (!normalized) return;
        if (!sameOrigin(normalized, pageUrl)) return;
        // Skip anchors to fragments-only on the same page.
        if (normalized.replace(/#.*$/, '') === pageUrl.replace(/#.*$/, '')) return;
        inAnchor = { href: normalized, text: '' };
        el.onEndTag(() => {
          if (inAnchor && inAnchor.text.trim()) anchorsCollecting.push(inAnchor);
          inAnchor = null;
        });
      },
      text(t) {
        if (inAnchor) inAnchor.text += t.text;
      },
    })
    .on('p, li, span, div', {
      text(t) {
        if (inScript || inStyle || inNav || inFooter || inAside > 0) return;
        if (textLen >= MAX_TEXT) return;
        const chunk = t.text;
        if (!chunk.trim()) return;
        textChunks.push(chunk);
        textLen += chunk.length;
      },
    });

  // Drain the rewriter; throw the body away (we just want the side-effects).
  await rewriter.transform(html).text();

  const excerpt = collapseWhitespace(textChunks.join(' ')).slice(0, MAX_TEXT);
  return {
    title: collapseWhitespace(title),
    h1: collapseWhitespace(h1),
    excerpt,
    internalAnchors: dedupeAnchors(anchorsCollecting),
  };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function dedupeAnchors(rows: { href: string; text: string }[]): { href: string; text: string }[] {
  const seen = new Set<string>();
  const out: { href: string; text: string }[] = [];
  for (const r of rows) {
    const key = r.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href: r.href, text: collapseWhitespace(r.text) });
  }
  return out;
}

export async function contentHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
