// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint v9 flat config. This repo is ESM (`"type": "module"`) and TypeScript-only:
// src/ is the shipped surface, tests/ and scripts/ are dev-time TS. The `lint` script
// targets src/ only; the tests/scripts blocks below apply when a wider path is passed.
//
// Not type-aware (`recommended`, not `recommendedTypeChecked`): type-aware linting
// needs a resolved tsconfig program per file, and tsconfig.json excludes tests/, so
// the type-checked preset would error on every test file it was asked to lint.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Warn, not error, during the initial rollout: this config is being added to a
      // codebase that has never been linted, so pre-existing findings become visible
      // debt rather than a wall of failures on the first run. As of this config there
      // are 58 `any` warnings and 15 unused-binding warnings, all pre-existing. Raise
      // both to 'error' once that backlog is cleared, so new violations block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests and one-off scripts legitimately reach for `any` and console output.
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
