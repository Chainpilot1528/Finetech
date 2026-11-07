import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/generated/**', '.dev/**', '**/next-env.d.ts', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (PRD §14.8).',
        },
      ],
    },
  },
  {
    // A module's internals are private: other modules import its index only (PRD §14.2).
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/modules/*/domain/*', '**/modules/*/adapters/*', '**/modules/*/application/*', '**/modules/*/http/*', '**/modules/*/ports/*'],
        message: "Import another module through its index.ts.",
      }] }],
    },
  },
);
