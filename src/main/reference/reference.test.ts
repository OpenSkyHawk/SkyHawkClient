import { describe, expect, it } from 'vitest'
import {
  A4EC_OUTPUTS,
  A4EC_OUTPUTS_BY_ADDRESS,
  A4EC_INPUTS,
  A4EC_INPUTS_BY_ID
} from './a4ec-controls.generated'
import { HID_CONTROLS, HID_CONTROLS_BY_ID, HID_ID } from './hid-controls.generated'
import { HID_REPORT_LAYOUT } from './hid-report-layout.generated'
import {
  NODE_STATUS,
  NODE_HEALTH_FLAGS,
  NODE_FAULT_CODES,
  NODE_TELEM,
  TELEM_PAGES,
  PDU_RAIL_FLAGS,
  PDU_STATUS_FLAGS
} from './node-status.generated'
import { NODE_NAMES } from './node-names.generated'
import { CAL_PROTO, CAL_TYPES, CAL_NACK_REASONS, CAL_PAYLOAD_LEN } from './axis-cal.generated'
import { ACFT_NAME } from './dcsbios-metadata'
import {
  HFLAG_DEGRADED,
  HFLAG_OVERHEAT,
  NODE_END_MSG,
  NODE_MSG,
  NODE_REQ_ADDR,
  SUPPORTED_NODE_PROTO
} from '@shared/nodes'
import {
  NODE_TELEM_MSG,
  PDU_FLAG,
  RAIL_FLAG,
  SUPPORTED_TELEM_PROTO,
  TELEM_PAGE
} from '@shared/node-telem'
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
    expect(NODE_STATUS.reqAddress).toBe(NODE_REQ_ADDR)
    expect(NODE_STATUS.msgName).toBe(NODE_MSG)
    expect(NODE_STATUS.endMsgName).toBe(NODE_END_MSG)
  })

  it('health-flag masks match the decoder (firmware bit reassignment fails loudly)', () => {
    expect(NODE_HEALTH_FLAGS.OVERHEAT).toBe(HFLAG_OVERHEAT)
    expect(NODE_HEALTH_FLAGS.DEGRADED).toBe(HFLAG_DEGRADED)
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

// shared/node-telem.ts restates these so `src/shared` needs no `src/main` import. Compared in both
// directions, so a page or flag added, removed or renumbered firmware-side fails here.
describe('node-telem contract', () => {
  it('matches the shared decoder (fails loudly on a firmware bump)', () => {
    expect(NODE_TELEM.protoVersion).toBe(SUPPORTED_TELEM_PROTO)
    expect(NODE_TELEM.msgName).toBe(NODE_TELEM_MSG)
  })

  it('page ids and flag bits match the decoder exactly', () => {
    expect(TELEM_PAGES).toEqual(TELEM_PAGE)
    expect(PDU_RAIL_FLAGS).toEqual(RAIL_FLAG)
    expect(PDU_STATUS_FLAGS).toEqual(PDU_FLAG)
  })
})

// shared/calibration.ts restates these constants rather than importing them, because `src/shared`
// is aliased everywhere and `src/main/reference` is not. That duplication is only safe because
// these assertions are exhaustive in BOTH directions — a firmware bump that adds, removes or
// renumbers anything has to fail here, not surface as a mis-framed packet on the wire.
describe('axis-cal.generated', () => {
  it('scalar contract matches the codec', () => {
    expect(CAL_PROTO.version).toBe(cal.CAL_PROTO_VERSION)
    expect(CAL_PROTO.axisSlots).toBe(cal.AXIS_CAL_SLOTS)
    expect(CAL_PROTO.axisNone).toBe(cal.CAL_AXIS_NONE)
    expect(CAL_PROTO.envelopeBytes).toBe(cal.CAL_ENVELOPE_BYTES)
    expect(CAL_PROTO.maxPayload).toBe(cal.CAL_MAX_PAYLOAD)
    expect([...CAL_PROTO.magic]).toEqual([...cal.CAL_MAGIC])
  })

  it('every message type agrees, in both directions', () => {
    const generated = new Map(
      Object.entries(CAL_TYPES).map(([code, info]) => [info!.name, Number(code)])
    )
    const codec = new Map(Object.entries(cal.CAL_TYPE))
    // Same names on both sides — catches a type added or dropped firmware-side.
    expect([...codec.keys()].sort()).toEqual([...generated.keys()].sort())
    for (const [name, code] of codec) expect(generated.get(name), name).toBe(code)
  })

  it('every payload length agrees, for every type', () => {
    for (const [name, code] of Object.entries(cal.CAL_TYPE)) {
      expect(CAL_PAYLOAD_LEN[code], name).toBe(cal.CAL_PAYLOAD_LEN[code])
    }
    // No length in the codec that the firmware does not declare, and vice versa.
    expect(
      Object.keys(cal.CAL_PAYLOAD_LEN)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(
      Object.keys(CAL_PAYLOAD_LEN)
        .map(Number)
        .sort((a, b) => a - b)
    )
  })

  it('every NACK reason agrees, in both directions', () => {
    const generated = new Map(
      Object.entries(CAL_NACK_REASONS).map(([code, info]) => [info!.name, Number(code)])
    )
    const codec = new Map(Object.entries(cal.CAL_NACK))
    expect([...codec.keys()].sort()).toEqual([...generated.keys()].sort())
    for (const [name, code] of codec) expect(generated.get(name), name).toBe(code)
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
