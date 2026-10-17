// Opt-in diagnostics to <userData>/debug.log. Off by default; toggled from
// Settings. Passive logging (serial events) is gated by the enabled flag; an
// explicit user action (dump serial ports) can force a write regardless.
import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

let enabled = false

export function setDebugEnabled(value: boolean): void {
  enabled = value
}

export function isDebugEnabled(): boolean {
  return enabled
}

export function debugLogPath(): string {
  return join(app.getPath('userData'), 'debug.log')
}

function safe(data: unknown): string {
  if (data === undefined) return ''
  try {
    return ' ' + (typeof data === 'string' ? data : JSON.stringify(data))
  } catch {
    return ' ' + String(data)
  }
}

export function debugLog(tag: string, data?: unknown, force = false): void {
  if (!enabled && !force) return
  try {
    appendFileSync(debugLogPath(), `[${new Date().toISOString()}] ${tag}${safe(data)}\n`)
  } catch {
    // best-effort; a read-only userData dir shouldn't crash the app
  }
}
