import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The renderer's titlebar version, defined the way the app build defines it (electron.vite.config.ts).
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

// Two projects, split by file extension: `*.test.ts` run on node (every test that existed before
// the component harness, unchanged), `*.test.tsx` are renderer component tests in jsdom.
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        resolve: { alias: { '@shared': resolve('src/shared') } },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts']
        }
      },
      {
        extends: true,
        plugins: [react()],
        define: { __APP_VERSION__: JSON.stringify(version) },
        resolve: {
          alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.tsx'],
          setupFiles: ['src/renderer/test/setup.ts']
        }
      }
    ]
  }
})
