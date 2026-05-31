// @recto/eslint-plugin-voice
//
// Two rules:
//   no-banned-lexicon       — flags BRAND-VOICE §4 hard-ban words in user-facing strings.
//   no-hook-antipattern     — flags BRAND-VOICE §1B anti-patterns ("without sacrificing",
//                              " effortlessly", "X. Period.") anywhere in copy.
//
// Scope: string literals, template element strings, and JSX text nodes.
// Soft-ban words are advisory and emit warn, not error — they're allowed in
// technical contexts and code identifiers.

import { HOOK_ANTIPATTERNS, makeHardBanRegex, makeSoftBanRegex } from './banned-lexicon.js';

const HARD = makeHardBanRegex();
const SOFT = makeSoftBanRegex();

// Strings shorter than this likely aren't user-facing copy (e.g., keys,
// imports). Skip to keep noise out.
const MIN_COPY_LENGTH = 12;

// A hard-ban word is a CODE identifier, not marketing copy, when it sits next to
// a path/identifier/key separator — e.g. magic-link auth: "/api/auth/magic"
// (route), "magic_tokens" (SQL table), "rl:magic:${ip}" (KV key). BRAND-VOICE §4
// governs user-facing copy, not technical strings, so these are allowlisted.
const TECH_ADJACENT = /[/_:]/;
function isTechnicalUse(text, idx, word) {
  const before = idx > 0 ? text[idx - 1] : '';
  const after = text[idx + word.length] || '';
  return TECH_ADJACENT.test(before) || TECH_ADJACENT.test(after);
}

function checkText(context, node, text) {
  if (!text || typeof text !== 'string') return;
  if (text.length < MIN_COPY_LENGTH) return;

  // Report the first hard-ban hit that is NOT a technical identifier.
  const hardRe = new RegExp(HARD.source, 'gi');
  let m;
  while ((m = hardRe.exec(text)) !== null) {
    if (isTechnicalUse(text, m.index, m[0])) continue;
    context.report({
      node,
      messageId: 'hardBan',
      data: { word: m[0], snippet: snippet(text, m.index) },
    });
    break;
  }

  const soft = SOFT.exec(text);
  if (soft) {
    context.report({
      node,
      messageId: 'softBan',
      data: { word: soft[0], snippet: snippet(text, soft.index) },
    });
  }

  for (const ap of HOOK_ANTIPATTERNS) {
    if (ap.pattern.test(text)) {
      context.report({
        node,
        messageId: 'hookAntipattern',
        data: { msg: ap.msg, snippet: snippet(text, 0) },
      });
      break;
    }
  }
}

// Skip strings that are module specifiers — import paths, dynamic import()
// arguments, require() arguments. These are filenames, not user-facing copy.
function isModuleSpecifier(node) {
  const p = node.parent;
  if (!p) return false;
  if (
    p.type === 'ImportDeclaration' ||
    p.type === 'ExportAllDeclaration' ||
    p.type === 'ExportNamedDeclaration'
  ) {
    return p.source === node;
  }
  if (p.type === 'ImportExpression') {
    return p.source === node;
  }
  if (
    p.type === 'CallExpression' &&
    p.callee &&
    ((p.callee.type === 'Identifier' && p.callee.name === 'require') ||
      (p.callee.type === 'Import'))
  ) {
    return p.arguments[0] === node;
  }
  return false;
}

function snippet(text, idx) {
  const start = Math.max(0, idx - 16);
  const end = Math.min(text.length, idx + 32);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

/** @type {import('eslint').Rule.RuleModule} */
const noBannedLexicon = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Reject BRAND-VOICE §4 banned lexicon in user-facing strings.',
    },
    schema: [],
    messages: {
      hardBan: 'BRAND-VOICE §4 hard-ban word: "{{word}}" in "{{snippet}}". Replace with §5 preferred lexicon.',
      softBan: 'BRAND-VOICE §4 soft-ban word: "{{word}}" in "{{snippet}}". Use literal/technical only.',
      hookAntipattern: '{{msg}} (in "{{snippet}}")',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (isModuleSpecifier(node)) return;
        checkText(context, node, node.value);
      },
      TemplateElement(node) {
        if (node.value && typeof node.value.cooked === 'string') {
          checkText(context, node, node.value.cooked);
        }
      },
      JSXText(node) {
        checkText(context, node, node.value);
      },
    };
  },
};

export default {
  meta: { name: '@recto/eslint-plugin-voice', version: '0.0.1' },
  rules: {
    'no-banned-lexicon': noBannedLexicon,
  },
  configs: {
    recommended: {
      plugins: ['@recto/voice'],
      rules: {
        '@recto/voice/no-banned-lexicon': 'error',
      },
    },
  },
};
