// Pure HID-report decode helpers. Layout is fixed by the SimGateway firmware
// (Firmware/Libraries/SimGateway/SimGateway.cpp:17-21):
//   uint8_t buttons[16]  // 128 x 1-bit
//   uint8_t hats[2]      // 4 x 4-bit nibble
//   int16_t axes[8]      // X Y Z Rx Ry Rz Slider Dial (little-endian)
// => 34 bytes, no report id.

export const HID_REPORT_SIZE = 34
export const HID_AXIS_COUNT = 8
export const HID_BUTTON_COUNT = 128
export const HID_HAT_COUNT = 4

const BUTTONS_OFFSET = 0
const HATS_OFFSET = 16
const AXES_OFFSET = 18

/** Firmware encodes each axis as uint16; the signed centre is value - 0x8000. */
export function decodeAxis(raw: number): number {
  return (raw & 0xffff) - 0x8000
}

/** Button n lives at byte n/8, bit n%8 of the buttons[] block. */
export function isButtonPressed(buttons: Uint8Array, n: number): boolean {
  if (n < 0 || n >= HID_BUTTON_COUNT) return false
  return (buttons[n >> 3]! & (1 << (n & 7))) !== 0
}

/** Hat nibble: 0 = centre, 1..8 = N..NW, anything > 8 is the null/centre value. */
export function decodeHat(nibble: number): number {
  return nibble >= 1 && nibble <= 8 ? nibble : 0
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
  const buttonsBlock = report.subarray(BUTTONS_OFFSET, BUTTONS_OFFSET + 16)
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
