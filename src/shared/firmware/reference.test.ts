import { describe, expect, it } from 'vitest'
import {
  A4EC_OUTPUTS,
  A4EC_OUTPUTS_BY_ADDRESS,
  A4EC_INPUTS,
  A4EC_INPUTS_BY_ID,
  HID_CONTROLS,
  HID_CONTROLS_BY_ID,
  HID_ID,
  HID_REPORT_LAYOUT,
  NODE_STATUS,
  NODE_FAULT_CODES,
  NODE_TELEM,
  NODE_NAMES,
  CAL_PROTO,
  CAL_TYPES,
  CAL_ACK_FIELD,
  CAL_COMMIT_FIELD,
  CAL_DATA_FIELD,
  CAL_DATA_REC_FIELD,
  CAL_DIAG_BYTES,
  CAL_DIAG_FIELD,
  CAL_DIAG_RESET_REASONS,
  CAL_HELLO_ACK_FIELD,
  CAL_NACK_FIELD,
  CAL_RAW_FIELD,
  CAL_RESET_FIELD,
  CAL_SESSION_ACK_FIELD,
  CAL_SESSION_OPEN_FIELD,
  CAL_STREAM_SELECT_FIELD,
  DIE_TEMP_UNAVAILABLE,
  GATEWAY_NODE_ID,
  HB_ESR_REC_SHIFT,
  HB_ESR_TEC_SHIFT,
  HEARTBEAT_FLAGS,
  NODE_STATUS_FIELD,
  NODE_STATUS_ROW_BYTES,
  NODE_TELEM_FIELD,
  NODE_TELEM_ROW_BYTES,
  NTC_TEMP_UNAVAILABLE,
  PDU_RAIL_FIELD,
  PDU_STATUS_FIELD,
  CAL_PAYLOAD_LEN,
  MAX_NODE_ID,
  TELEM_PERIOD_MS,
  USB_IDENTITY,
  PDU_RAIL_FLAGS,
  PDU_RAIL_FLAG_INFO,
  PDU_STATUS_FLAGS,
  PDU_STATUS_FLAG_INFO,
  type NodeFaultName
} from '.'
import { ACFT_NAME } from '../../main/dcs/bios-protocol'
import { SUPPORTED_NODE_PROTO } from '../../main/nodes/node-status-wire'
import { SUPPORTED_TELEM_PROTO } from '../../main/nodes/node-telem'
import * as cal from '../../main/hid/calibration/codec'

describe('a4ec-controls.generated', () => {
  it('has outputs, each with a numeric address', () => {
    expect(A4EC_OUTPUTS.length).toBeGreaterThan(300)
    for (const o of A4EC_OUTPUTS) expect(Number.isInteger(o.address)).toBe(true)
  })

  it('indexes outputs by address', () => {
    const sample = A4EC_OUTPUTS[0]!
    const bucket = A4EC_OUTPUTS_BY_ADDRESS.get(sample.address)
    expect(bucket).toBeDefined()
    expect(bucket!.some((o) => o.id === sample.id)).toBe(true)
  })

  it('indexes inputs by id for command lookup', () => {
    const sample = A4EC_INPUTS[0]!
    expect(A4EC_INPUTS_BY_ID.get(sample.id)).toBeDefined()
  })
})

describe('hid-controls.generated', () => {
  it('maps the axis controlIds', () => {
    expect(HID_CONTROLS.length).toBeGreaterThan(0)
    expect(HID_CONTROLS_BY_ID.get(0x10)?.label).toBe('Roll')
  })

  it('carries the routing ranges', () => {
    expect(HID_ID.AXIS_MIN).toBe(0x10)
    expect(HID_ID.BUTTON_MAX).toBe(0xaf)
    expect(HID_ID.HID_MAX).toBe(0xff)
  })
})

describe('hid-report-layout.generated', () => {
  it('is the fixed 34-byte layout', () => {
    expect(HID_REPORT_LAYOUT.size).toBe(34)
    expect(HID_REPORT_LAYOUT.buttons.offset).toBe(0)
    expect(HID_REPORT_LAYOUT.hats.offset).toBe(16)
    expect(HID_REPORT_LAYOUT.axes.offset).toBe(18)
    expect(HID_REPORT_LAYOUT.axes.usages).toHaveLength(8)
  })

  it('declares signed axes (no 0x8000 bias)', () => {
    expect(HID_REPORT_LAYOUT.axes.signed).toBe(true)
    expect(HID_REPORT_LAYOUT.axes.min).toBe(-32768)
  })

  it('pins the axis maximum and the hat directions the UI text is built from', () => {
    // "signed ±32767" (CalibrationDialog) and "8-way POV" (HID tab) read these.
    expect(HID_REPORT_LAYOUT.axes.max).toBe(32767)
    expect(HID_REPORT_LAYOUT.hats.directions).toBe(8)
    expect(HID_REPORT_LAYOUT.hats.centeredAtOrAbove).toBe(8)
  })
})

// The client finds the Gateway by vid/pid and shows its product name; a firmware change to any of
// them must fail here rather than leave the client looking for a board that no longer enumerates.
describe('usb-identity.generated', () => {
  it('pins the SimGateway USB identity', () => {
    expect(USB_IDENTITY.vid).toBe(0x2e8a)
    expect(USB_IDENTITY.pid).toBe(0x4134)
    expect(USB_IDENTITY.manufacturer).toBe('OpenSkyhawk')
    expect(USB_IDENTITY.product).toBe('A-4E Skyhawk')
    expect(USB_IDENTITY.cdcInterface).toBe('A-4E Skyhawk DCS-BIOS')
    expect(USB_IDENTITY.baud).toBe(250000)
  })
})

describe('node-bus.generated', () => {
  it('pins the NODE_ID ceiling the status and telemetry decoders gate on', () => {
    expect(MAX_NODE_ID).toBe(63)
  })

  it('pins the PDU telemetry period TELEM_STALE_MS was chosen against', () => {
    expect(TELEM_PERIOD_MS).toBe(1000)
  })
})

describe('node-names.generated', () => {
  it('maps NODE_ID 0 to PanelBridge and includes registered panels', () => {
    expect(NODE_NAMES[0]?.name).toBe('PanelBridge')
    expect(Object.keys(NODE_NAMES).length).toBeGreaterThan(0)
  })
})

describe('dcsbios-metadata', () => {
  it('pins _ACFT_NAME at 0x0000, 24 bytes', () => {
    expect(ACFT_NAME.address).toBe(0x0000)
    expect(ACFT_NAME.maxLength).toBe(24)
  })
})

describe('node-status.generated', () => {
  it('matches the shared decoder contract (fails loudly on a firmware bump)', () => {
    expect(NODE_STATUS.protoVersion).toBe(SUPPORTED_NODE_PROTO)
  })

  // 0x86FE is a live DCS-BIOS address (AH-64D, Mirage F1); no module exports at 0xFF00 (D23).
  it('pins the roster request at 0xFF00', () => {
    expect(NODE_STATUS.reqAddress).toBe(0xff00)
  })

  it('fault-code dictionary pins every known code (append-only; a renumber fails loudly)', () => {
    // Each id -> name + badge tag. A code appended at 0x09+ still passes; swapping or renaming an
    // existing one (which would put the wrong badge on a degraded node) does not.
    const pinned: Record<number, { name: string; abbr: string }> = {
      0x00: { name: 'NONE', abbr: 'NONE' },
      0x01: { name: 'I2C_PERIPHERAL', abbr: 'I2C' },
      0x02: { name: 'OVER_VOLTAGE', abbr: 'OVER-V' },
      0x03: { name: 'UNDER_VOLTAGE', abbr: 'UNDER' },
      0x04: { name: 'SHORT_CIRCUIT', abbr: 'SHORT' },
      0x05: { name: 'HOST_LINK_LOST', abbr: 'HOST' },
      0x06: { name: 'FUSE_OPEN', abbr: 'FUSE' },
      0x07: { name: 'OVER_TEMPERATURE', abbr: 'OVER-T' },
      0x08: { name: 'SENSOR_FAULT', abbr: 'SENSOR' }
    }
    for (const [id, want] of Object.entries(pinned)) {
      expect(NODE_FAULT_CODES[Number(id)], `fault 0x${Number(id).toString(16)}`).toMatchObject(want)
    }
    expect(NODE_FAULT_CODES[1]?.label).toBe('I2C peripheral')
    // every entry carries a non-empty label except NONE
    for (const [id, e] of Object.entries(NODE_FAULT_CODES)) {
      if (Number(id) !== 0) expect(e?.label.length).toBeGreaterThan(0)
    }
    // an unknown/reserved id (parseNodeStatus passes any faultId through) is undefined, not a crash —
    // the Partial<Record> type forces callers to ?.-guard.
    expect(NODE_FAULT_CODES[0x99]).toBeUndefined()
  })

  it('fault names are typed: a misspelt name does not compile', () => {
    const known: NodeFaultName = 'HOST_LINK_LOST'
    // @ts-expect-error -- not a NodeFaultCode name
    const typo: NodeFaultName = 'HOST_LINK_LOSS'
    expect([known, typo]).toHaveLength(2)
  })

  it('PDU flag info names every flag bit, keyed by the bit', () => {
    for (const [flags, info] of [
      [PDU_RAIL_FLAGS, PDU_RAIL_FLAG_INFO],
      [PDU_STATUS_FLAGS, PDU_STATUS_FLAG_INFO]
    ] as const) {
      expect(Object.keys(info)).toHaveLength(Object.keys(flags).length)
      for (const [name, bit] of Object.entries(flags)) {
        expect(info[bit]?.name).toBe(name)
        expect(info[bit]?.description.length).toBeGreaterThan(0)
      }
    }
  })

  it('fault badge tags are unique (OVER_VOLTAGE and OVER_TEMPERATURE must not both read OVER)', () => {
    const tags = Object.values(NODE_FAULT_CODES).map((e) => e?.abbr)
    expect(new Set(tags).size).toBe(tags.length)
  })

  // nodes/node-status-wire.ts decodes the row by these names (#346). Pinned at the values the
  // decoder was proven against, so a firmware relayout fails here before it mis-decodes a node.
  it('pins the _NODE_STATUS row layout the decoder reads', () => {
    expect(GATEWAY_NODE_ID).toBe(0)
    expect(NODE_STATUS_ROW_BYTES).toBe(19)
    expect(NODE_STATUS_FIELD).toEqual({
      ID: 0,
      PRESENT: 1,
      HB_FLAGS: 2,
      UPTIME: 3,
      RX_COUNT: 5,
      ESR: 7,
      DIE_TEMP_C: 9,
      HEALTH_FLAGS: 10,
      FAULT_MASK: 11,
      FAULT_ID: 12,
      NODE_KIND: 13,
      FW_MAJOR: 14,
      FW_MINOR: 15,
      FW_PATCH: 16,
      BOOTLOADER: 17,
      BOOT_STATE: 18
    })
  })

  it('pins the heartbeat flag bits, the ESR split and the die-temperature sentinel', () => {
    expect(HEARTBEAT_FLAGS).toEqual({ BOFF: 0x01, EPVF: 0x02 })
    expect(HB_ESR_TEC_SHIFT).toBe(0)
    expect(HB_ESR_REC_SHIFT).toBe(8)
    // Signed int8; the row carries its byte, 0x80.
    expect(DIE_TEMP_UNAVAILABLE).toBe(-128)
    expect(DIE_TEMP_UNAVAILABLE & 0xff).toBe(0x80)
  })
})

// nodes/node-telem.ts imports its page ids and flag bits from here; only the decoder's protocol
// version is its own, so a firmware bump fails here rather than mis-decoding.
describe('node-telem contract', () => {
  it('matches the shared decoder (fails loudly on a firmware bump)', () => {
    expect(NODE_TELEM.protoVersion).toBe(SUPPORTED_TELEM_PROTO)
  })

  it('pins the _NODE_TELEM framing and the PDU page offsets the decoder reads (#346)', () => {
    expect(NODE_TELEM_ROW_BYTES).toBe(9)
    expect(NODE_TELEM_FIELD).toEqual({ ID: 0, FRAME: 1 })
    expect(PDU_RAIL_FIELD).toEqual({ FLAGS: 1, V_AVG_MV: 2, V_MIN_MV: 4, I_AVG_MA: 6 })
    expect(PDU_STATUS_FIELD).toEqual({ FLAGS: 1, NTC_TEMP_DC: 2, I12_PEAK_MA: 4, I5_PEAK_MA: 6 })
    // Signed int16; the frame carries 0x8000.
    expect(NTC_TEMP_UNAVAILABLE).toBe(-32768)
    expect(NTC_TEMP_UNAVAILABLE & 0xffff).toBe(0x8000)
  })
})

// hid/calibration/codec.ts imports these from here. The codec's framing and payload decoders are
// written for one protocol version, so a firmware bump to another has to fail here, not surface as
// a mis-framed packet on the wire.
describe('axis-cal.generated', () => {
  it('is the protocol version the codec is written for', () => {
    expect(CAL_PROTO.version).toBe(1)
  })

  it('pins the largest frame and the device session timeout', () => {
    expect(CAL_PROTO.maxFrame).toBe(92)
    expect(CAL_PROTO.maxFrame).toBe(CAL_PROTO.envelopeBytes + CAL_PROTO.maxPayload)
    // KEEPALIVE_MS (main/hid/calibration/cal-link.ts) is client policy chosen to land well inside this.
    expect(CAL_PROTO.sessionTimeoutMs).toBe(30000)
  })

  it('name tables are typed by the generated names: a misspelt name does not compile', () => {
    expect(cal.CAL_TYPE.HELLO).toBe(0x01)
    expect(cal.CAL_NACK.NO_SESSION).toBeDefined()
    // @ts-expect-error -- FOO is not a CalType name
    expect(cal.CAL_TYPE.FOO).toBeUndefined()
    // @ts-expect-error -- BAD_FOO is not a CalNackReason name
    expect(cal.CAL_NACK.BAD_FOO).toBeUndefined()
  })

  it('marks device-originated types by the high bit', () => {
    for (const [code, info] of Object.entries(CAL_TYPES)) {
      expect(info!.fromDevice, info!.name).toBe(Number(code) >= 0x80)
    }
  })

  it('pins the payload field offsets the codec reads and writes (#346)', () => {
    expect(CAL_HELLO_ACK_FIELD).toEqual({
      PROTO: 0,
      BLOB_VERSION: 1,
      AXIS_SLOTS: 2,
      FW_MAJOR: 3,
      FW_MINOR: 4,
      FW_PATCH: 5
    })
    expect(CAL_DATA_FIELD).toEqual({ PRESENT_MASK: 0, CALIBRATED_MASK: 1, RECORDS: 2 })
    expect(CAL_PROTO.dataRecBytes).toBe(10)
    expect(CAL_DATA_REC_FIELD).toEqual({ CONTROL_ID: 0, MIN: 2, CENTRE: 4, MAX: 6, DEADZONE: 8 })
    // CAL_DATA is exactly the two masks and the eight records.
    expect(CAL_DATA_FIELD.RECORDS + CAL_PROTO.axisSlots * CAL_PROTO.dataRecBytes).toBe(
      CAL_PROTO.maxPayload
    )
    expect(CAL_SESSION_OPEN_FIELD).toEqual({ AXIS_IDX: 0 })
    expect(CAL_SESSION_ACK_FIELD).toEqual({ TIMEOUT_MS: 0, AXIS_IDX: 4 })
    expect(CAL_STREAM_SELECT_FIELD).toEqual({ AXIS_IDX: 0 })
    expect(CAL_COMMIT_FIELD).toEqual({ IDX: 0, MIN: 1, CENTRE: 3, MAX: 5, DEADZONE: 7 })
    expect(CAL_RESET_FIELD).toEqual({ IDX: 0 })
    expect(CAL_ACK_FIELD).toEqual({ TYPE: 0 })
    expect(CAL_NACK_FIELD).toEqual({ TYPE: 0, REASON: 1, DETAIL: 2 })
    expect(CAL_RAW_FIELD).toEqual({ IDX: 0, RAW: 1, CAL: 3 })
  })

  it('COMMIT carries exactly one axis — 9 bytes, never a batch', () => {
    // The batch form allowed a message to name the same axis twice and silently apply the last.
    // If this length ever grows, encodeCommit() is wrong in kind, not merely short.
    expect(CAL_PAYLOAD_LEN[cal.CAL_TYPE.COMMIT]).toBe(9)
  })

  // codec.decodeDiag reads DIAG by these names (#169). Pinned at the layout it was written for:
  // a relayout fails here; a counter added in the reserved bytes does not (bytes 0–46 stay put).
  it('pins GET_DIAG / DIAG and the DIAG layout the decoder reads', () => {
    expect(cal.CAL_TYPE.GET_DIAG).toBe(0x09)
    expect(cal.CAL_TYPE.DIAG).toBe(0x87)
    expect(CAL_PAYLOAD_LEN[0x09]).toBe(0)
    expect(CAL_DIAG_BYTES).toBe(64)
    expect(CAL_PAYLOAD_LEN[0x87]).toBe(CAL_DIAG_BYTES)
    expect(CAL_DIAG_BYTES).toBeLessThanOrEqual(CAL_PROTO.maxPayload) // fits the receiver's carry
    expect(CAL_DIAG_FIELD).toEqual({
      UPTIME_MS: 0,
      FIRST_UART_ERR_MS: 4,
      LAST_UART_ERR_MS: 8,
      FIRST_USB_LOSS_MS: 12,
      LAST_USB_LOSS_MS: 16,
      UART_OVERRUN: 20,
      UART_FRAMING: 22,
      UART_BREAK: 24,
      UART_PARITY: 26,
      UART_RX_OVERFLOW: 28,
      LINES_DROPPED: 30,
      LINES_CORRUPT: 32,
      LINES_OVERLONG: 34,
      FRAMES_DROPPED: 36,
      UART_RESTARTS: 38,
      USB_REATTACHES: 40,
      CDC_STALLS: 42,
      RECOVERY_REBOOTS: 44,
      WATCHDOG_RESETS: 45,
      RESET_REASON: 46,
      RESERVED: 47
    })
    expect(CAL_DIAG_RESET_REASONS).toEqual({ POWER_ON: 0, WATCHDOG: 1, RECOVERY: 2 })
  })
})
