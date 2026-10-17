// Renderer still calls these; they move to main in R3.x and this file disappears.
//
// Pure, no Node/Electron deps. Main imports them from here too, so there is one copy.
import type { EventSeverity, LogEvent } from './ipc'

/** @deprecated Renderer still calls this; it moves to main in R3.x. */
export const SEVERITY_GLYPH: Record<EventSeverity, string> = {
  error: '✕',
  warn: '!',
  new: '+',
  info: '●'
}

/**
 * What "Problems only" keeps: something is wrong — not a new node, a cleared flag or a link up.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function isProblem(e: Pick<LogEvent, 'severity'>): boolean {
  return e.severity === 'error' || e.severity === 'warn'
}
