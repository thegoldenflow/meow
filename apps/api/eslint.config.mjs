// @ts-check
// Flat-config port of the NestJS default ESLint template (non type-checked,
// loose rules). Formatting is delegated to Prettier (see .prettierrc).
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Existing code predates this config: ~50 files drift from Prettier
      // output (868 diffs). Off until a dedicated formatting pass lands, so
      // `npm run lint` (--fix) doesn't mass-reformat business code.
      'prettier/prettier': 'off',
      // Pre-existing violations (29 at setup time) downgraded to warn instead
      // of touching business code. Promote back to error once cleaned up.
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-useless-escape': 'warn',
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
);
