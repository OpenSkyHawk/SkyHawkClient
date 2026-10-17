// What a HID report means for the HID tab (pure, no Node/Electron deps): how fresh it is, and which
// axis slots are live (R3.3). Moved from the renderer (freshness.ts, Hid.tsx) so HidService decides
// them; `hid:report` carries them.
import type { CalSnapshot } from '@shared/hid/calibration'
import type { HidFreshness, HidReportFacts } from '@shared/hid'
import { HID_REPORT_LAYOUT } from '@shared/firmware'

/**
 * How recently the device last said anything, as a band.
 *
 * **Never a fault while the board is attached, deliberately.** The gateway sends a HID report only
 * when a control changes, so silence is the normal resting state of a cockpit nobody is touching —
 * and a fault colour would cry wolf every time the user stopped moving. The fault is reserved for
 * the one case that really is wrong: the board is not there, so nothing *could* arrive — and that
 * is the link's call (`device:status` boardPresent), not the report's age.
 *
 * The thresholds are minutes rather than seconds for the same reason — an axis untouched for a
 * minute says nothing about the hardware. They started at 10 and 20 minutes and came down to 1
 * and 5 after bench use: at ten minutes the readout effectively never changed, so it carried no
 * information for the cost of a card.
 */
export const FRESH_MS = 60 * 1000
export const RECENT_MS = 5 * 60 * 1000

/** The band for a report `ageMs` old (the board present). */
export function freshnessBand(ageMs: number): HidFreshness {
  if (ageMs < FRESH_MS) return 'live'
  if (ageMs < RECENT_MS) return 'idle'
  return 'quiet'
}

/**
 * The report's band, and the axis slots the tab shows live.
 *
 * Two different notions of "this axis exists", answering different questions:
 *   catalogued (`availAxes`) — what HIDControls.h catalogues, i.e. what the report layout can carry
 *   presentMask (`snap`)     — what THIS gateway's sketch actually declares
 *
 * An axis is live only if both are true. A catalogued slot the device never declared reads a
 * constant 0, and rendering that as a value implies a reading that does not exist — so it gets
 * the same dimmed em-dash treatment as an uncatalogued slot. Until the device tells us
 * (no gateway, or firmware predating the protocol) we fall back to the catalogue alone.
 */
export function hidFacts(
  ageMs: number,
  snap: CalSnapshot | undefined,
  availAxes: readonly number[]
): HidReportFacts {
  const catalogued = new Set(availAxes)
  const present = snap ? snap.axes.filter((a) => a.present) : []
  const axisLive = (i: number) =>
    catalogued.has(i) && (snap ? (snap.axes[i]?.present ?? false) : true)
  return {
    band: freshnessBand(ageMs),
    present: present.length,
    axisLive: Array.from({ length: HID_REPORT_LAYOUT.axes.count }, (_, i) => axisLive(i))
  }
}
