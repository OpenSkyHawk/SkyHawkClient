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
  CAL_PAYLOAD_LEN
} from '.'
import { ACFT_NAME } from '../../main/reference/dcsbios-metadata'
import { SUPPORTED_NODE_PROTO } from '@shared/nodes'
import { SUPPORTED_TELEM_PROTO } from '@shared/node-telem'
import * as cal from '@shared/calibration'

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

  it('fault badge tags are unique (OVER_VOLTAGE and OVER_TEMPERATURE must not both read OVER)', () => {
    const tags = Object.values(NODE_FAULT_CODES).map((e) => e?.abbr)
    expect(new Set(tags).size).toBe(tags.length)
  })
})

// shared/node-telem.ts imports its page ids and flag bits from here; only the decoder's protocol
// version is its own, so a firmware bump fails here rather than mis-decoding.
describe('node-telem contract', () => {
  it('matches the shared decoder (fails loudly on a firmware bump)', () => {
    expect(NODE_TELEM.protoVersion).toBe(SUPPORTED_TELEM_PROTO)
  })
})

// shared/calibration.ts imports these from here. The codec's framing and payload decoders are
// written for one protocol version, so a firmware bump to another has to fail here, not surface as
// a mis-framed packet on the wire.
describe('axis-cal.generated', () => {
  it('is the protocol version the codec is written for', () => {
    expect(CAL_PROTO.version).toBe(1)
  })

  it('marks device-originated types by the high bit', () => {
    for (const [code, info] of Object.entries(CAL_TYPES)) {
      expect(info!.fromDevice, info!.name).toBe(Number(code) >= 0x80)
    }
  })

  it('COMMIT carries exactly one axis — 9 bytes, never a batch', () => {
    // The batch form allowed a message to name the same axis twice and silently apply the last.
    // If this length ever grows, encodeCommit() is wrong in kind, not merely short.
    expect(CAL_PAYLOAD_LEN[cal.CAL_TYPE.COMMIT]).toBe(9)
  })
})
