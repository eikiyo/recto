// recto-api ESLint config. Flat config (ESLint 9+).
// Enforces BRAND-VOICE §4 + §1B via @recto/voice plugin on string + template
// literals in routes/handlers, since this is where user-facing copy leaks.

import voice from '@recto/eslint-plugin-voice';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@recto/voice': voice },
    rules: {
      '@recto/voice/no-banned-lexicon': 'error',
    },
  },
  {
    // Lint configs/migrations get a pass — copy doesn't live here.
    ignores: ['src/db/migrations/**', 'src/db/migrations-down/**', 'drizzle.config.ts'],
  },
];
