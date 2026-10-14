// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'scripts/**',
      'agui-frontend/**',
      'src/tts_and_stt/**/*.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: ['**/*.dto.ts'],
    rules: {
      // class-validator decorators are often flagged as unsafe-call under strict type-checked
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Evaluation utilities are plain Node.js ESM, not TypeScript project files.
    // Keep syntax/style linting without asking projectService for TS type data.
    files: ['evals/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
    },
  },
  {
    // @nestjs/event-emitter resolves at build time; ESLint projectService may not load its types
    files: ['src/common/app-event-emitter.module.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
