// Phrase matching — the core of the "wrap an EXISTING phrase in place" model.
//
// The anchor we insert is never authored; it is a phrase that already exists in
// the source post. These helpers (1) confirm a phrase is a verbatim substring
// of the page's prose and (2) locate that phrase inside the live post HTML so we
// can wrap it WITHOUT changing any of the blog's words. Matching is
// whitespace-flexible (HTML collapses/varies whitespace) but never crosses a
// tag boundary, so a match always lands inside a single text node.

const SAFE_PHRASE = /^[\p{L}\p{N} ,.'’\-]+$/u;

// Collapse runs of whitespace to single spaces and trim. Both the crawled body
// and a user/LLM-supplied phrase are normalized this way before comparison.
export function normalizePhrase(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// A phrase is "clean" if it is plain prose words (letters/digits/spaces plus a
// few inline punctuation marks). We restrict selection to clean phrases so the
// matcher never has to reconcile HTML entities (&amp;, smart quotes via
// wptexturize, etc.) between the crawled text and the raw post HTML.
export function isCleanPhrase(phrase: string): boolean {
  const p = normalizePhrase(phrase);
  if (p.length < 6 || p.length > 80) return false;
  const words = p.split(' ');
  if (words.length < 2 || words.length > 8) return false;
  return SAFE_PHRASE.test(p);
}

// Is `phrase` a verbatim (whitespace-flexible) substring of `text`? Used to
// validate that an anchor — LLM-selected or user-edited — actually exists in the
// source page body before we ever try to push it.
export function phraseInText(text: string | null | undefined, phrase: string): boolean {
  if (!text) return false;
  const hay = normalizePhrase(text).toLowerCase();
  const needle = normalizePhrase(phrase).toLowerCase();
  if (!needle) return false;
  return hay.includes(needle);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a regex that matches the phrase with flexible *whitespace* between words
// but never spans a tag (whitespace class excludes '<'/'>'). Word characters are
// escaped verbatim so punctuation in the phrase must match literally.
function buildPhraseRegex(phrase: string): RegExp {
  const words = normalizePhrase(phrase).split(' ').map(escapeRegex);
  const pattern = words.join('[ \\t\\r\\n\\u00a0]+');
  return new RegExp(pattern, 'gi');
}

// Find the nearest REAL <a> anchor open-tag before idx. `lastIndexOf('<a', idx)`
// is wrong: "<a" is a prefix of "<article", "<aside", "<abbr", "<address",
// "<audio", "<area" — all common in post bodies (esp. <abbr> for acronyms like
// SEO/HTML/API). When one of those was the nearest "<a…" before a phrase and no
// real anchor closed between, the old check reported the phrase as anchored and
// findPhrase skipped it → the link was never inserted (core value path silently
// failed). Require the char after "<a" to be a tag-name boundary (>, space, tab,
// newline, form-feed, or "/") so only genuine <a> tags match. (Hardened 2026-06-07.)
function lastAnchorOpen(html: string, idx: number): number {
  let from = idx;
  for (;;) {
    const i = html.lastIndexOf('<a', from);
    if (i === -1) return -1;
    const next = html[i + 2];
    if (
      next === undefined || next === '>' || next === ' ' || next === '\t' ||
      next === '\n' || next === '\r' || next === '\f' || next === '/'
    ) {
      return i;
    }
    if (i === 0) return -1;
    from = i - 1; // skip this <article>/<abbr>/… and keep scanning backward
  }
}

function isInsideAnchor(html: string, idx: number): boolean {
  const open = lastAnchorOpen(html, idx);
  if (open === -1) return false;
  // "</a>" requires the '>' right after 'a', so it never matches "</article>"
  // or "</abbr>" — the close side was already correct.
  const close = html.lastIndexOf('</a>', idx);
  return open > close;
}

// Find the first wrappable occurrence of `phrase` in `html`:
//   - not already inside an <a> ... </a>
//   - matched text contains no '<' (guaranteed by the whitespace class)
// If `scopeHint` is given (e.g. the paragraph the phrase was selected from), we
// prefer a match that falls within the first occurrence of that hint, so we wrap
// the intended instance when a phrase repeats. Returns the match range and the
// EXACT matched substring (its original casing/spacing) so the caller wraps the
// blog's own text unchanged. Returns null when no safe occurrence exists.
export function findPhrase(
  html: string,
  phrase: string,
  scopeHint?: string | null
): { start: number; end: number; matched: string } | null {
  const p = normalizePhrase(phrase);
  if (!p) return null;
  let re: RegExp;
  try {
    re = buildPhraseRegex(p);
  } catch {
    return null;
  }

  // Determine a preferred window from the scope hint, if present.
  let windowStart = -1;
  let windowEnd = -1;
  if (scopeHint) {
    const hintWords = normalizePhrase(scopeHint).split(' ').slice(0, 6).map(escapeRegex);
    if (hintWords.length >= 2) {
      try {
        const hintRe = new RegExp(hintWords.join('[ \\t\\r\\n\\u00a0]+'), 'i');
        const m = hintRe.exec(html);
        if (m) {
          windowStart = m.index;
          windowEnd = m.index + 4000; // generous paragraph-sized window
        }
      } catch {
        /* ignore bad hint */
      }
    }
  }

  const matches: Array<{ start: number; end: number; matched: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].includes('<') || m[0].includes('>')) continue;
    if (isInsideAnchor(html, start)) continue;
    matches.push({ start, end, matched: m[0] });
    if (re.lastIndex === start) re.lastIndex++; // guard against zero-width loops
  }
  if (matches.length === 0) return null;

  if (windowStart !== -1) {
    const inWindow = matches.find((x) => x.start >= windowStart && x.start <= windowEnd);
    if (inWindow) return inWindow;
  }
  return matches[0] ?? null;
}
