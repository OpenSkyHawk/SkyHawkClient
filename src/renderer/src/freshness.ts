import type { DeviceState } from '@shared/ipc'

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

/**
 * States in which the device link is actually up.
 *
 * Keyed on the device rather than on whether the *relay* is running, which was the original
 * mistake: pulling the USB cable leaves the relay running — it is trying to reconnect — so a
 * `running` flag stays true while nothing can possibly arrive, and the card went on ageing
 * through its bands to 'quiet'. Quiet and unplugged are opposite claims: one says the device has
 * nothing to say, the other that it cannot say anything.
 */
const LINK_UP: ReadonlySet<DeviceState> = new Set<DeviceState>(['relaying', 'connected'])

export function freshness(deviceState: DeviceState, ageMs: number) {
  if (!LINK_UP.has(deviceState)) return { cls: 'rate--down', label: 'no link' }
  if (ageMs < FRESH_MS) return { cls: 'rate--live', label: 'live' }
  if (ageMs < RECENT_MS) return { cls: 'rate--idle', label: 'idle' }
  return { cls: 'rate--stale', label: 'quiet' }
}
