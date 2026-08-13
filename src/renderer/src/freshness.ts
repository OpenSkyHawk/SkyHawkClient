/**
 * How recently the device last said anything, as a colour.
 *
 * **Never red while the link is up, deliberately.** The gateway sends a HID report only when a
 * control changes, so silence is the normal resting state of a cockpit nobody is touching — and
 * a fault colour would cry wolf every time the user stopped moving. Red is reserved for the one
 * case that really is wrong: the link is down, so nothing *could* arrive.
 *
 * The thresholds are minutes rather than seconds for the same reason. An axis untouched for
 * eight minutes says nothing about the hardware.
 */
export const FRESH_MS = 10 * 60 * 1000
export const RECENT_MS = 20 * 60 * 1000

export function freshness(relaying: boolean, ageMs: number) {
  if (!relaying) return { cls: 'rate--down', label: 'no link' }
  if (ageMs < FRESH_MS) return { cls: 'rate--live', label: 'live' }
  if (ageMs < RECENT_MS) return { cls: 'rate--idle', label: 'idle' }
  return { cls: 'rate--stale', label: 'quiet' }
}
