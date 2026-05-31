import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import plugin from '../src/index.js';

function lint(code) {
  const linter = new Linter();
  return linter.verify(code, {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { '@recto/voice': plugin },
    rules: { '@recto/voice/no-banned-lexicon': 'error' },
  });
}

describe('@recto/voice/no-banned-lexicon', () => {
  it('flags hard-ban word in a string literal', () => {
    const msgs = lint('const x = "Supercharge your link graph today";');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe('hardBan');
    expect(msgs[0].message).toMatch(/supercharge/i);
  });

  it('flags hard-ban word inside a template literal', () => {
    const msgs = lint('const x = `Unleash the orphan candidates now`;');
    expect(msgs.some((m) => m.messageId === 'hardBan')).toBe(true);
  });

  it('flags hard-ban word inside JSX text', () => {
    const msgs = lint('export default () => (<div>Magical AI-powered SEO platform</div>);');
    expect(msgs.some((m) => m.messageId === 'hardBan')).toBe(true);
  });

  it('flags hook anti-pattern "without sacrificing"', () => {
    const msgs = lint('const x = "Recover traffic without sacrificing control today";');
    expect(msgs.some((m) => m.messageId === 'hookAntipattern')).toBe(true);
  });

  it('flags "effortlessly" via hook anti-pattern', () => {
    const msgs = lint('const x = "Connect your site effortlessly to start";');
    expect(msgs.some((m) => m.messageId === 'hookAntipattern' || m.messageId === 'hardBan')).toBe(true);
  });

  it('passes the locked recto hero copy', () => {
    const code = `const hero = "Recover the traffic your site forgot. Without giving up the seat at the keyboard.";`;
    const msgs = lint(code);
    expect(msgs).toHaveLength(0);
  });

  it('passes short strings (likely identifiers, not copy)', () => {
    const msgs = lint('const k = "magic";'); // under MIN_COPY_LENGTH
    expect(msgs).toHaveLength(0);
  });

  it('passes legitimate technical text using preferred lexicon', () => {
    const code = `const t = "Surface orphans in your site. We crawl once a day and rank candidates.";`;
    const msgs = lint(code);
    expect(msgs).toHaveLength(0);
  });

  it('does NOT flag banned words appearing as import path segments', () => {
    const code = `import { magic } from '../auth/magic';\nimport x from './magic-link-helper.js';`;
    const msgs = lint(code);
    expect(msgs).toHaveLength(0);
  });

  it('does NOT flag banned words in dynamic import() / require() paths', () => {
    const code = `await import('./magic.ts'); require('./magical-helper');`;
    const msgs = lint(code);
    expect(msgs).toHaveLength(0);
  });

  it('flags soft-ban "leverage" in long copy', () => {
    const code = `const t = "Leverage our analytics to grow your audience size measurably";`;
    const msgs = lint(code);
    expect(msgs.some((m) => m.messageId === 'softBan')).toBe(true);
  });

  // Technical magic-link contexts are code identifiers, not copy — must NOT flag.
  it('does NOT flag "magic" in an auth route path', () => {
    const code = `app.use('/api/auth/magic', handler);`;
    expect(lint(code)).toHaveLength(0);
  });

  it('does NOT flag "magic" in a SQL table identifier', () => {
    const code = `const q = 'INSERT INTO magic_tokens (hash, user_id) VALUES (?, ?)';`;
    expect(lint(code)).toHaveLength(0);
  });

  it('does NOT flag "magic" in a KV key template', () => {
    const code = 'const key = `rl:magic:${ip}-window`;';
    expect(lint(code)).toHaveLength(0);
  });

  it('STILL flags "magic" used as marketing copy (not technical)', () => {
    const code = `const x = "Our orphan finder feels like magic to every user";`;
    const msgs = lint(code);
    expect(msgs.some((m) => m.messageId === 'hardBan')).toBe(true);
  });
});
