// The HID report and what the firmware catalogues, as main pushes them (R3.4b: the hid slice of
// the old single store, cut verbatim). No intents: the IPC adapter only delivers the pushes.
import { create } from 'zustand'
import { HID_REPORT_LAYOUT } from '@shared/firmware'
import type { HidAvailability, HidFreshness, HidReport } from '@shared/hid'

export interface HidState {
  // HID live state + which report indices the firmware catalogues (rest dim)
  axes: number[]
  buttons: number[]
  hats: number[]
  hidRate: number
  /** The report's age as main bands it (`hid:report`, R3.3). */
  hidBand: HidFreshness
  /** Axis slots this Gateway declares, as main counts them (`hid:report`). */
  hidPresent: number
  /** Per axis slot: shown live (catalogued and declared), as main decides it (`hid:report`). */
  axisLive: boolean[]
  availHats: number[]
  availButtons: number[]
}

export const useHidStore = create<HidState>(() => ({
  axes: Array(HID_REPORT_LAYOUT.axes.count).fill(0),
  buttons: [],
  hats: Array(HID_REPORT_LAYOUT.hats.count).fill(0),
  availHats: [],
  availButtons: [],
  hidRate: 0,
  // A report 0 ms old reads live; no slot is live until main says so (as before the catalogue).
  hidBand: 'live',
  hidPresent: 0,
  axisLive: []
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const hidFromMain = {
  /** `hid:availability`. */
  availability: (a: HidAvailability): void =>
    useHidStore.setState({ availHats: a.hats, availButtons: a.buttons }),

  /** `hid:report`. */
  report: (h: HidReport): void =>
    useHidStore.setState({
      axes: h.axes,
      buttons: h.buttons.flatMap((b, i) => (b ? [i] : [])),
      hats: h.hats,
      hidRate: h.rateHz,
      hidBand: h.band,
      hidPresent: h.present,
      axisLive: h.axisLive
    })
}
