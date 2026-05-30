import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSortPlugin from 'eslint-plugin-simple-import-sort';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.local/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'simple-import-sort': simpleImportSortPlugin,
      'unused-imports': unusedImportsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,
      ...tsPlugin.configs['stylistic-type-checked'].rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportNamespaceSpecifier',
          message: 'Use named imports instead of namespace imports.',
        },
        {
          selector:
            "CallExpression[callee.object.object.name='process'][callee.object.property.name=/^(stdout|stderr)$/][callee.property.name='write']",
          message: 'Use output/printer.ts instead of writing directly to process stdout or stderr.',
        },
      ],

      'default-case-last': 'error',

      eqeqeq: 'error',
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'no-multi-assign': 'error',
      'no-nested-ternary': 'error',
      'no-param-reassign': 'error',
      'no-shadow': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'prefer-destructuring': 'error',
      'prefer-object-spread': 'error',
      'prefer-promise-reject-errors': 'error',
      'prefer-spread': 'error',
      'prefer-template': 'error',
      'require-await': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    // eslint-config-prettier disables `curly` and `padding-line-between-statements` to
    // avoid conflicts, but these configurations are safe to use alongside Prettier.
    rules: {
      curly: ['error', 'all'],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['if', 'for', 'while', 'do', 'switch', 'try'], next: '*' },
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
    },
  },
];
