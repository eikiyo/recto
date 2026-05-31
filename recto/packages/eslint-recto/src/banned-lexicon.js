// Source of truth: artifacts/BRAND-VOICE.md §4 (banned) + §1B (hook anti-patterns).
// Keep this list in sync with the document. The rule reads this file only —
// it does not parse the markdown at runtime to keep ESLint fast and offline.

export const HARD_BAN_WORDS = [
  'supercharge',
  'unleash',
  'revolutionize',
  'game-changer',
  '10x',
  'effortless',
  'effortlessly',
  'seamless',
  'seamlessly',
  'delight',
  'magic',
  'magical',
  'ai-powered',
  'next-gen',
  'cutting-edge',
  'state-of-the-art',
  'world-class',
  'best-in-class',
  'synergy',
  'empower',
  'crush it',
  'level up',
  'boost',
  'turbocharge',
  'ecosystem',
  'holistic',
];

// Verbs banned only as marketing voice — allowed in code identifiers.
// Detected as standalone words inside copy-only contexts (JSXText, string
// literals exceeding 12 chars, template elements). Single-word bans on these
// inside short identifier-like strings would produce false positives.
export const SOFT_BAN_WORDS = [
  'leverage', // banned as verb
  'unlock',   // banned metaphorical
  'optimize', // banned when over-used (we allow in technical text; rule flags only when long copy)
  'platform', // banned when 'tool' works
  'robust',
  'intuitive',
  'simply',
  'just', // filler — too noisy; only flag when adjacent to claim words
];

// Hook anti-patterns from §1B. Phrase-level matches.
export const HOOK_ANTIPATTERNS = [
  { pattern: /without sacrificing\b/i, msg: '"without sacrificing" is the academic version. Use "without giving up Y." (§1B)' },
  { pattern: /\beffortlessly\b/i, msg: '"effortlessly" collapses the hook into one sentence. Split with a period. (§1B)' },
  { pattern: /\.\s+period\.?$/im, msg: '"X. Period." trying too hard. The period is implicit. (§1B)' },
];

// Build the matcher: word-boundary, case-insensitive, escape regex metachars.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeHardBanRegex() {
  const alts = HARD_BAN_WORDS.map(escapeRegex).join('|');
  return new RegExp(`\\b(?:${alts})\\b`, 'i');
}

export function makeSoftBanRegex() {
  const alts = SOFT_BAN_WORDS.map(escapeRegex).join('|');
  return new RegExp(`\\b(?:${alts})\\b`, 'i');
}
