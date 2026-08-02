/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', 'main.js'],
  env: {
    browser: true,
    node: true,
    es2021: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'jest', 'simple-import-sort'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { args: 'none', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/no-explicit-any': 'off',
    'simple-import-sort/imports': 'error',
    'simple-import-sort/exports': 'error',
  },
  overrides: [
    {
      files: [
        'src/features/inline-edit/InlineEditService.ts',
        'src/features/chat/services/InstructionRefineService.ts',
        'src/core/runtime/**/*.ts',
        'src/core/security/**/*.ts',
        'src/core/tools/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['./ui', './ui/*', '../ui', '../ui/*'],
                message: 'Service and shared modules must not import UI modules.',
              },
              {
                group: ['./CodianView', '../CodianView', '../chat/CodianView'],
                message: 'Service and shared modules must not import the view.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['tests/**/*.ts'],
      env: { jest: true },
      extends: ['plugin:jest/recommended'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
