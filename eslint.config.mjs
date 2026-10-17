import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

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
  }
)
