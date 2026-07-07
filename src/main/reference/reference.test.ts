import { describe, expect, it } from 'vitest'
import {
  A4EC_OUTPUTS,
  A4EC_OUTPUTS_BY_ADDRESS,
  A4EC_INPUTS,
  A4EC_INPUTS_BY_ID
} from './a4ec-controls.generated'
import { HID_CONTROLS, HID_CONTROLS_BY_ID, HID_ID } from './hid-controls.generated'
import { HID_REPORT_LAYOUT } from './hid-report-layout.generated'
import { NODE_STATUS, NODE_HEALTH_FLAGS, NODE_FAULT_CODES } from './node-status.generated'
import { NODE_NAMES } from './node-names.generated'
import { ACFT_NAME } from './dcsbios-metadata'
import {
  HFLAG_DEGRADED,
  HFLAG_OVERHEAT,
  NODE_END_MSG,
  NODE_MSG,
  NODE_REQ_ADDR,
  SUPPORTED_NODE_PROTO
} from '@shared/nodes'

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

  it('fault-code dictionary pins the core codes (append-only; a renumber fails loudly)', () => {
    expect(NODE_FAULT_CODES[0]?.name).toBe('NONE')
    expect(NODE_FAULT_CODES[1]?.name).toBe('I2C_PERIPHERAL')
    expect(NODE_FAULT_CODES[1]?.abbr).toBe('I2C')
    expect(NODE_FAULT_CODES[1]?.label).toBe('I2C peripheral')
    // every entry carries a non-empty label except NONE
    for (const [id, e] of Object.entries(NODE_FAULT_CODES)) {
      if (Number(id) !== 0) expect(e?.label.length).toBeGreaterThan(0)
    }
    // an unknown/reserved id (parseNodeStatus passes any faultId through) is undefined, not a crash —
    // the Partial<Record> type forces callers to ?.-guard.
    expect(NODE_FAULT_CODES[0x99]).toBeUndefined()
  })
})
