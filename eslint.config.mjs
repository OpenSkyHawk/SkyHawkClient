import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// #190: one owner for hex and for unknown-code labels, src/shared/format (hexCode, unknownLabel,
// hex2, hex4). A flat config replaces a rule's options per file rather than merging them, so the
// last block below carries P5 and these together for the renderer files both apply to.
const ONE_FORMAT_OWNER = [
  {
    selector: "CallExpression[callee.property.name='toString'][arguments.0.value=16]",
    message: 'Format hex with hexCode / hex2 / hex4 from @shared/format (#190).'
  },
  {
    selector: 'TemplateElement[value.raw=/nknown[^(]*\\($/i]',
    message: "Label a code this client doesn't know with unknownLabel from @shared/format (#190)."
  }
]
const FORMAT_OWNER_EXEMPT = [
  'src/shared/format/**',
  '**/*.test.{ts,tsx}',
  '**/*.test-d.ts',
  'src/renderer/test/**',
  'src/test-fixtures/**'
]

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', '**/*.generated.ts']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: FORMAT_OWNER_EXEMPT,
    rules: { 'no-restricted-syntax': ['error', ...ONE_FORMAT_OWNER] }
  },
  {
    // P5 (SkyHawkClient#97): only the IPC adapter talks to main. A dependency graph can't see a
    // global, so this lives here rather than in .dependency-cruiser.cjs. An error since R3.4b.
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/app/ipc-adapter.ts', 'src/renderer/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='skyhawk']",
          message: 'Only app/ipc-adapter.ts talks to main; use your topic store (P5).'
        }
      ]
    }
  },
  {
    // P5 and #190 together: the renderer files both rules cover (see ONE_FORMAT_OWNER).
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/renderer/src/app/ipc-adapter.ts', ...FORMAT_OWNER_EXEMPT],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='skyhawk']",
          message: 'Only app/ipc-adapter.ts talks to main; use your topic store (P5).'
        },
        ...ONE_FORMAT_OWNER
      ]
    }
  }
)
