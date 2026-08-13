/**
 * How recently the device last said anything, as a colour.
 *
 * **Never red while the link is up, deliberately.** The gateway sends a HID report only when a
 * control changes, so silence is the normal resting state of a cockpit nobody is touching — and
 * a fault colour would cry wolf every time the user stopped moving. Red is reserved for the one
 * case that really is wrong: the link is down, so nothing *could* arrive.
 *
 * The thresholds are minutes rather than seconds for the same reason — an axis untouched for a
 * minute says nothing about the hardware. They started at 10 and 20 minutes and came down to 1
 * and 5 after bench use: at ten minutes the readout effectively never changed, so it carried no
 * information for the cost of a card.
 */
export const FRESH_MS = 60 * 1000
export const RECENT_MS = 5 * 60 * 1000

export function freshness(relaying: boolean, ageMs: number) {
  if (!relaying) return { cls: 'rate--down', label: 'no link' }
  if (ageMs < FRESH_MS) return { cls: 'rate--live', label: 'live' }
  if (ageMs < RECENT_MS) return { cls: 'rate--idle', label: 'idle' }
  return { cls: 'rate--stale', label: 'quiet' }
}
