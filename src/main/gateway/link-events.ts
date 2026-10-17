// Device-link events (pure, no Node/Electron deps): the event-log row a Gateway link change makes.
import type { LogEventInput } from '@shared/events'
import type { DeviceStatus } from '@shared/gateway'

/**
 * A device-link change worth a row, or null. `last` is the last state other than `scanning`,
 * which never makes a row — it comes and goes on every retry — so a retry loop of
 * scanning → no-device → scanning adds nothing after its first "no device".
 */
export function deviceEvent(
  last: DeviceStatus['state'] | undefined,
  next: DeviceStatus,
  now: number
): LogEventInput | null {
  if (next.state === 'scanning' || next.state === last) return null
  const base = { t: now, source: 'client' as const, name: 'Gateway' }
  const raw = ['device:', next.state, next.portPath, next.detail].filter(Boolean).join(' ')
  switch (next.state) {
    case 'connected':
      return { ...base, severity: 'info', event: 'connected', detail: next.portPath, raw }
    case 'reconnecting':
      return { ...base, severity: 'warn', event: 'reconnecting', detail: 'link dropped', raw }
    case 'error':
      // The link raises the same failure as a SERIAL error, which already makes the row.
      return null
    case 'no-device':
      // Launching (or pressing Connect) with nothing plugged in is a resting state, not news.
      if (last === undefined || last === 'disconnected') return null
      return { ...base, severity: 'warn', event: 'no device', detail: 'unplugged', raw }
    case 'disconnected':
      return { ...base, severity: 'info', event: 'disconnected', raw }
  }
}
