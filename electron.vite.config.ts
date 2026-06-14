import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = { '@shared': resolve('src/shared') }

// Surface the package.json version to the renderer so the titlebar never drifts
// from what release-please bumps.
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react()]
  }
})
