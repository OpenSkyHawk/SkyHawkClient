import type { DeviceState } from '@shared/gateway/ipc'

/**
 * How recently the device last said anything, as a colour.
 *
 * **Never red while the board is attached, deliberately.** The gateway sends a HID report only when a
 * control changes, so silence is the normal resting state of a cockpit nobody is touching — and
 * a fault colour would cry wolf every time the user stopped moving. Red is reserved for the one
 * case that really is wrong: the board is not there, so nothing *could* arrive.
 *
 * The thresholds are minutes rather than seconds for the same reason — an axis untouched for a
 * minute says nothing about the hardware. They started at 10 and 20 minutes and came down to 1
 * and 5 after bench use: at ten minutes the readout effectively never changed, so it carried no
 * information for the cost of a card.
 */
export const FRESH_MS = 60 * 1000
export const RECENT_MS = 5 * 60 * 1000

/**
 * Whether the board can be sending HID reports at all, judged from the serial link's state.
 *
 * The joystick is a second interface on the same USB device and is read alongside DCS, so it
 * does not need the serial port open (#69, #74). What it needs is the board plugged in, and the
 * link state is the only evidence of that the renderer has:
 *
 *   connected            — open, so plugged in
 *   error                — typically "port busy": another tool holds the CDC, the board is there
 *   disconnected         — released by Disconnect or with auto-connect off; normally still plugged
 *   no-device / scanning / reconnecting — not found, or not yet: nothing can arrive
 *
 * The one case this misreads is an unplug while auto-connect is off: the link was already
 * released, nobody is looking for the port, so it stays `disconnected` and the card ages to
 * "quiet" instead of saying "no link". Nothing on the serial side can see that unplug, and the
 * HID reader does not reliably either — it is the accepted cost of not polling for the board.
 */
const BOARD_PRESENT: ReadonlySet<DeviceState> = new Set(['connected', 'error', 'disconnected'])

/**
 * Keyed on the board being attached rather than on whether the *relay* is running, which was
 * the original mistake: pulling the USB cable leaves the relay running — it is trying to
 * reconnect — so a `running` flag stays true while nothing can possibly arrive, and the card went
 * on ageing through its bands to 'quiet'. Quiet and unplugged are opposite claims: one says the
 * device has nothing to say, the other that it cannot say anything.
 *
 * Nor on the serial link being up, which was the second: a released port leaves the joystick
 * working, and red "no link" over live axes says the opposite of what the user can see.
 */
export function freshness(deviceState: DeviceState, ageMs: number) {
  if (!BOARD_PRESENT.has(deviceState)) return { cls: 'rate--down', label: 'no link' }
  if (ageMs < FRESH_MS) return { cls: 'rate--live', label: 'live' }
  if (ageMs < RECENT_MS) return { cls: 'rate--idle', label: 'idle' }
  return { cls: 'rate--stale', label: 'quiet' }
}
