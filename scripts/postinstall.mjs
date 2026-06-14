// Ensure the Electron binary is present after `npm install`.
// Electron 42 ships no install script of its own (scripts: {}), so the ~120 MB
// runtime binary is never fetched automatically. This runs Electron's installer.
//
// Skipped in CI (it only lints/typechecks/builds — it never launches the app) and
// on Node < 22, where electron/install.js (ESM) cannot run. The project requires
// Node 24; on it this downloads + extracts the binary so `npm run dev` works.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (process.env.CI) {
  console.log('[postinstall] CI detected — skipping Electron binary download.')
  process.exit(0)
}

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.warn(
    `[postinstall] Node ${process.versions.node} is < 22 — Electron 42 needs Node 24. ` +
      `Skipping; run "nvm use 24" and reinstall.`
  )
  process.exit(0)
}

const installer = 'node_modules/electron/install.js'
if (!existsSync(installer)) process.exit(0)

try {
  execFileSync(process.execPath, [installer], { stdio: 'inherit' })
  console.log('[postinstall] Electron binary ready.')
} catch (err) {
  console.warn('[postinstall] Electron binary install failed:', err.message)
}
