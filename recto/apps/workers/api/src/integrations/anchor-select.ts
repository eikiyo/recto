// Anchor-phrase SELECTION (replaces the old anchor authoring).
//
// The core value prop: we link an orphan by wrapping a phrase that ALREADY
// exists in the source post — we never write new sentences and never append a
// paragraph. So this module does not generate text; it SELECTS an existing
// phrase from the source body that (a) reads as natural anchor text and (b) is
// topically relevant to the orphan target.
//
// Pipeline per candidate:
//   1. Ask the model to COPY a 2–6 word phrase verbatim from the source body.
//   2. Self-check: the phrase must be "clean" prose AND a verbatim substring of
//      the source body (isCleanPhrase + phraseInText). Reject otherwise.
//   3. One retry with a stricter instruction.
//   4. Deterministic fallback: highest target-overlap clean window in the body.
//   5. Still nothing → phrase:null → the UI offers hand-pick (user selects text).
//
// LLM EXTRACTS, NEVER AUTHORS — the model only points at existing text; code
// validates it really exists before we trust it. (Kage doctrine, 2026-06-06.)

import { decrypt } from '../lib/crypto';
import { isCleanPhrase, phraseInText, normalizePhrase } from '../lib/phrase';

const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export type AnchorProvider =
  | 'workers-ai'
  | 'byok-openai'
  | 'byok-anthropic'
  | 'deterministic'
  | 'none';

export type AnchorSelectInput = {
  sourceBody: string; // the source page's cleaned prose (body_text || excerpt)
  targetTitle: string | null;
  targetH1: string | null;
  targetExcerpt: string | null;
  // The SOURCE page's own title + h1, used to scrub residual chrome (the post
  // title and byline) that bare/atypical themes leak into body_text even after
  // header/nav/footer stripping. Without this the selector picks the post's own
  // title — Recto would "link a page from its own title". (2026-06-06.)
  sourceTitle?: string | null;
  sourceH1?: string | null;
};

export type AnchorSelectOutput = {
  phrase: string | null; // null = no automatic phrase; caller offers hand-pick
  paragraph: string; // the sentence/snippet containing the phrase (UI context)
  provider: AnchorProvider;
  tokensApprox: number;
};

function prompt(input: AnchorSelectInput, strict: boolean): string {
  const target = [input.targetTitle, input.targetH1].filter(Boolean).join(' — ');
  return `You choose anchor text for an internal link by COPYING an existing phrase.

From the SOURCE TEXT below, copy a short phrase (2 to 6 consecutive words) that
ALREADY appears in it word-for-word and would read naturally as a link to the
TARGET page.

Rules:
- Output ONLY the phrase, copied EXACTLY from the source text (same words, same order, same spelling).
- Do NOT invent, paraphrase, translate, summarize, or add or drop words.${strict ? '\n- Your previous answer was NOT an exact copy. Copy a real consecutive run of words from the source.' : ''}
- Choose a descriptive noun phrase relevant to the target. Never "click here", "read more", "this article".
- Plain words only: no quotes, brackets, or trailing punctuation.

SOURCE TEXT:
${clip(input.sourceBody, 3500)}

TARGET page: ${target || '(untitled)'}
TARGET topic: ${clip(input.targetExcerpt ?? '', 300)}

Phrase:`;
}

export async function selectAnchorPhrase(
  env: { AI: Ai; RECTO_KEK: string },
  user: {
    byok_openai_key: Uint8Array | null;
    byok_anthropic_key: Uint8Array | null;
    preferByok: boolean;
  },
  input: AnchorSelectInput
): Promise<AnchorSelectOutput> {
  // Scrub residual title/byline chrome from the body BEFORE any selection so
  // neither the model nor the deterministic fallback can pick it.
  input = { ...input, sourceBody: sanitizeSourceBody(input.sourceBody, input.sourceTitle, input.sourceH1) };

  const hasAI = !!env.AI && typeof (env.AI as Ai).run === 'function';
  const useByok = user.preferByok && (user.byok_openai_key || user.byok_anthropic_key);

  if (hasAI || useByok) {
    for (const strict of [false, true]) {
      let raw = '';
      let provider: AnchorProvider = 'workers-ai';
      let tokensApprox = 0;
      try {
        const r = await callModel(env, user, prompt(input, strict));
        raw = r.text;
        provider = r.provider;
        tokensApprox = r.tokensApprox;
      } catch {
        break; // model error — drop to deterministic fallback
      }
      const phrase = sanitize(raw);
      if (isCleanPhrase(phrase) && phraseInText(input.sourceBody, phrase)) {
        return {
          phrase: normalizePhrase(phrase),
          paragraph: containingSnippet(input.sourceBody, phrase),
          provider,
          tokensApprox,
        };
      }
    }
  }

  // Deterministic fallback: pick the best clean window by target overlap.
  const det = deterministicPhrase(input);
  if (det) {
    return { phrase: det.phrase, paragraph: det.paragraph, provider: 'deterministic', tokensApprox: 0 };
  }
  // No automatic phrase — hand-pick path.
  return { phrase: null, paragraph: '', provider: 'none', tokensApprox: 0 };
}

// ── source-body chrome scrub ──────────────────────────────────────────────────

// Remove the source page's own title/h1 and a leading WP byline from its body
// text. We replace each chrome fragment with a sentence boundary ". " (rather
// than deleting) so it can never glue to the first real sentence and survive
// splitSentences. Theme-agnostic: works wherever the title/byline sit in the DOM.
export function sanitizeSourceBody(
  body: string,
  title?: string | null,
  h1?: string | null
): string {
  let s = body || '';
  const frags: string[] = [];
  for (const t of [h1, title]) {
    if (!t) continue;
    const full = t.trim();
    // Drop a trailing " – Site name" / " | Site" suffix that <title> carries.
    const core = (full.split(/\s[|–—-]\s/)[0] ?? full).trim();
    if (core.length >= 4) frags.push(core);
    if (full.length >= 4 && full !== core) frags.push(full);
  }
  // Longest first so a fuller title is removed before its core substring.
  frags.sort((a, b) => b.length - a.length);
  for (const f of frags) {
    s = s.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '. ');
  }
  // WordPress byline: "Written by <author> in <Category>" (no terminal period,
  // so it otherwise glues to the first sentence).
  s = s.replace(/\bWritten by\b[\s\S]{0,60}?\bin\s+[A-Za-z][\w&,'’ -]{0,40}/gi, '. ');
  return s.replace(/\s+/g, ' ').replace(/(?:\.\s*){2,}/g, '. ').trim();
}

// ── deterministic selection ──────────────────────────────────────────────────

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'was', 'were', 'have', 'has', 'had', 'will', 'can', 'our', 'their', 'his',
  'her', 'its', 'into', 'over', 'about', 'what', 'when', 'how', 'why', 'who',
  'which', 'they', 'them', 'than', 'then', 'but', 'not', 'all', 'any', 'more',
]);

function targetTokens(input: AnchorSelectInput): Set<string> {
  const text = [input.targetTitle, input.targetH1, input.targetExcerpt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const out = new Set<string>();
  for (const w of text.split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOP.has(w)) out.add(w);
  }
  return out;
}

// Slide a 2–5 word window across each sentence; keep clean windows; score by the
// number of distinct target tokens they contain. Returns the verbatim phrase and
// its sentence. Deterministic, no model.
export function deterministicPhrase(
  input: AnchorSelectInput
): { phrase: string; paragraph: string } | null {
  const tokens = targetTokens(input);
  if (tokens.size === 0) return null;
  const sentences = splitSentences(input.sourceBody);
  let best: { score: number; phrase: string; paragraph: string } | null = null;

  for (const sentence of sentences) {
    const words = sentence.split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = 2; len <= 5 && i + len <= words.length; len++) {
        const phrase = words.slice(i, i + len).join(' ');
        if (!isCleanPhrase(phrase)) continue;
        let score = 0;
        for (let j = i; j < i + len; j++) {
          const w = (words[j] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (tokens.has(w)) score += 1;
        }
        if (score === 0) continue;
        // Prefer more overlap, then shorter (tighter) phrases.
        const better = !best || score > best.score || (score === best.score && phrase.length < best.phrase.length);
        if (better) best = { score, phrase: normalizePhrase(phrase), paragraph: sentence };
      }
    }
  }
  return best ? { phrase: best.phrase, paragraph: best.paragraph } : null;
}

function splitSentences(body: string): string[] {
  return normalizePhrase(body)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function containingSnippet(body: string, phrase: string): string {
  const sentences = splitSentences(body);
  for (const s of sentences) {
    if (phraseInText(s, phrase)) return s;
  }
  return splitSentences(body)[0] ?? '';
}

// ── model plumbing ───────────────────────────────────────────────────────────

async function callModel(
  env: { AI: Ai; RECTO_KEK: string },
  user: { byok_openai_key: Uint8Array | null; byok_anthropic_key: Uint8Array | null; preferByok: boolean },
  p: string
): Promise<{ text: string; provider: AnchorProvider; tokensApprox: number }> {
  if (user.preferByok && user.byok_openai_key) {
    return await callOpenAI(env.RECTO_KEK, user.byok_openai_key, p);
  }
  if (user.preferByok && user.byok_anthropic_key) {
    return await callAnthropic(env.RECTO_KEK, user.byok_anthropic_key, p);
  }
  const res = (await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: 'user', content: p }],
    max_tokens: 32,
    temperature: 0.1,
  })) as { response?: string };
  return { text: res.response ?? '', provider: 'workers-ai', tokensApprox: Math.ceil(p.length / 4) };
}

async function callOpenAI(kek: string, encKey: Uint8Array, p: string) {
  const key = await decrypt(encKey, kek);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: p }],
      max_tokens: 32,
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`openai_${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    provider: 'byok-openai' as AnchorProvider,
    tokensApprox: Math.ceil(p.length / 4),
  };
}

async function callAnthropic(kek: string, encKey: Uint8Array, p: string) {
  const key = await decrypt(encKey, kek);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: p }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic_${res.status}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return {
    text: data.content?.[0]?.text ?? '',
    provider: 'byok-anthropic' as AnchorProvider,
    tokensApprox: Math.ceil(p.length / 4),
  };
}

function sanitize(raw: string): string {
  let s = raw.trim();
  // Models sometimes wrap in quotes or add a "Phrase:" prefix — strip those, but
  // do NOT alter interior words (we validate it as a verbatim substring next).
  s = s.replace(/^phrase:\s*/i, '').trim();
  s = s.replace(/^["'`]+|["'`.]+$/g, '').trim();
  // Take only the first line.
  s = (s.split('\n')[0] ?? '').trim();
  return s;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
