// Pure HID-report decode helpers. Layout is fixed by the SimGateway firmware
// (Firmware/Libraries/SimGateway/SimGateway.cpp:17-21):
//   uint8_t buttons[16]  // 128 x 1-bit
//   uint8_t hats[2]      // 4 x 4-bit nibble
//   int16_t axes[8]      // X Y Z Rx Ry Rz Slider Dial (little-endian)
// => 34 bytes, no report id. The numbers come from HID_REPORT_LAYOUT (shared/firmware), which the
// sync asserts against that struct.
import type { HidAvailability } from '@shared/hid'
import { HID_CONTROLS, HID_ID, HID_REPORT_LAYOUT } from '@shared/firmware'

export const HID_REPORT_SIZE = HID_REPORT_LAYOUT.size
export const HID_AXIS_COUNT = HID_REPORT_LAYOUT.axes.count
export const HID_BUTTON_COUNT = HID_REPORT_LAYOUT.buttons.count
export const HID_HAT_COUNT = HID_REPORT_LAYOUT.hats.count

const BUTTONS_OFFSET = HID_REPORT_LAYOUT.buttons.offset
const HATS_OFFSET = HID_REPORT_LAYOUT.hats.offset
const AXES_OFFSET = HID_REPORT_LAYOUT.axes.offset

/** Button n lives at byte n/8, bit n%8 of the buttons[] block. */
export function isButtonPressed(buttons: Uint8Array, n: number): boolean {
  if (n < 0 || n >= HID_BUTTON_COUNT) return false
  return (buttons[n >> 3]! & (1 << (n & 7))) !== 0
}

/**
 * USB hat nibble: 0..7 = N/NE/E/SE/S/SW/W/NW, value >= 8 (e.g. 0xF) = null/centred.
 * Returns a HAT_DIRS index: 0 = centre, 1..8 = N..NW.
 */
export function decodeHat(nibble: number): number {
  return nibble <= HID_REPORT_LAYOUT.hats.centeredAtOrAbove - 1 ? nibble + 1 : 0
}

/** Decode a full 34-byte HID report into axes/buttons/hats. */
export function decodeReport(report: Uint8Array): {
  axes: number[]
  buttons: boolean[]
  hats: number[]
} {
  if (report.length < HID_REPORT_SIZE) {
    throw new Error(`HID report too short: ${report.length} < ${HID_REPORT_SIZE}`)
  }
  const buttonsBlock = report.subarray(
    BUTTONS_OFFSET,
    BUTTONS_OFFSET + HID_REPORT_LAYOUT.buttons.bytes
  )
  const buttons: boolean[] = []
  for (let i = 0; i < HID_BUTTON_COUNT; i++) buttons.push(isButtonPressed(buttonsBlock, i))

  const hats: number[] = []
  for (let i = 0; i < HID_HAT_COUNT; i++) {
    const byte = report[HATS_OFFSET + (i >> 1)]!
    const nibble = i & 1 ? (byte >> 4) & 0xf : byte & 0xf
    hats.push(decodeHat(nibble))
  }

  const view = new DataView(report.buffer, report.byteOffset, report.byteLength)
  const axes: number[] = []
  for (let i = 0; i < HID_AXIS_COUNT; i++) {
    axes.push(view.getInt16(AXES_OFFSET + i * 2, true))
  }

  return { axes, buttons, hats }
}

/** Report indices the firmware catalogues, derived from HIDControls.h. */
export function hidAvailability(): HidAvailability {
  const axes: number[] = []
  const hats: number[] = []
  const buttons: number[] = []
  for (const c of HID_CONTROLS) {
    if (
      c.id >= HID_ID.AXIS_MIN &&
      c.id <= HID_ID.AXIS_MAX &&
      c.id - HID_ID.AXIS_MIN < HID_REPORT_LAYOUT.axes.count
    ) {
      axes.push(c.id - HID_ID.AXIS_MIN)
    } else if (
      c.id >= HID_ID.HAT_MIN &&
      c.id <= HID_ID.HAT_MAX &&
      c.id - HID_ID.HAT_MIN < HID_REPORT_LAYOUT.hats.count
    ) {
      hats.push(c.id - HID_ID.HAT_MIN)
    } else if (
      c.id >= HID_ID.BUTTON_MIN &&
      c.id <= HID_ID.BUTTON_MAX &&
      c.id - HID_ID.BUTTON_MIN < HID_REPORT_LAYOUT.buttons.count
    ) {
      buttons.push(c.id - HID_ID.BUTTON_MIN)
    }
  }
  return { axes, hats, buttons }
}
