import { describe, expect, it } from 'vitest'
import {
  hasFreshPduPage,
  NodeTelemStore,
  parseNodeTelem,
  TELEM_PAGE,
  TELEM_STALE_MS
} from './node-telem'
import { displayCurrentMa, PDU_FLAG, RAIL_FLAG } from '@shared/nodes/legacy-rules'
import type { NodeTelem } from '@shared/nodes'

/** `_NODE_TELEM` argument: nodeId + the 8 frame bytes, as the bridge forwards them. */
const telem = (nodeId: number, bytes: number[]) =>
  [nodeId, ...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const le = (v: number) => [v & 0xff, (v >> 8) & 0xff]

const parse = (hex: string): NodeTelem => {
  const t = parseNodeTelem(hex)
  if (!t) throw new Error(`fixture did not parse: ${hex}`)
  return t
}

// The firmware's own forwarding test: OpenSkyhawk @ 22b6a87e,
// Firmware/Tests/PanelBridge/tests/node_telem/node_telem.cpp. Copied verbatim, uppercase as the
// bridge prints them (%02X), so these do not depend on this file's encoder agreeing with the decoder.
describe('parseNodeTelem — firmware vectors', () => {
  it('node 3 PDU_RAIL_12V: 12000 mV avg, 11800 min, 700 mA (node_telem.cpp:13)', () => {
    expect(parseNodeTelem('030100E02E182EBC02')).toEqual({
      nodeId: 3,
      kind: 'rail',
      page: TELEM_PAGE.PDU_RAIL_12V,
      flags: 0,
      vAvgMv: 12000,
      vMinMv: 11800,
      iAvgMa: 700
    })
  })

  it('node 5 PDU_STATUS: flags 03, 25.0 °C, peaks 10000 / 4660 mA (node_telem.cpp:14)', () => {
    expect(parseNodeTelem('050303FA0010273412')).toEqual({
      nodeId: 5,
      kind: 'status',
      page: TELEM_PAGE.PDU_STATUS,
      flags: PDU_FLAG.UNCAL_VDDA | PDU_FLAG.UNCAL_ZERO,
      ntcTempC: 25,
      i12PeakMa: 10000,
      i5PeakMa: 4660
    })
  })

  // node_telem.cpp:46-48 — frames the bridge drops. Should one leak through, the client drops it too.
  it('rejects the frames the bridge must drop: page 0, a 4-byte frame, node 0', () => {
    expect(parseNodeTelem('030001020304050607')).toBeNull() // page0[] on canIdTelem(3)
    expect(parseNodeTelem('030100E02E')).toBeNull() // rail12[] truncated to 4 bytes
    expect(parseNodeTelem('000100E02E182EBC02')).toBeNull() // rail12[] on canIdTelem(0)
  })
})

describe('parseNodeTelem', () => {
  it('decodes a 12 V rail page, little-endian, with a signed current', () => {
    const hex = telem(3, [0x01, RAIL_FLAG.UNDER_V, ...le(12034), ...le(11950), ...le(-12 & 0xffff)])
    expect(hex).toBe('030101022fae2ef4ff')
    expect(parseNodeTelem(hex)).toEqual({
      nodeId: 3,
      kind: 'rail',
      page: TELEM_PAGE.PDU_RAIL_12V,
      flags: RAIL_FLAG.UNDER_V,
      vAvgMv: 12034,
      vMinMv: 11950,
      iAvgMa: -12
    })
  })

  it('decodes a 5 V rail page', () => {
    const t = parse(telem(4, [0x02, 0, ...le(5012), ...le(4980), ...le(1830)]))
    expect(t).toMatchObject({
      kind: 'rail',
      page: TELEM_PAGE.PDU_RAIL_5V,
      vAvgMv: 5012,
      iAvgMa: 1830
    })
  })

  it('decodes a status page with NTC temperature in 0.1 °C, including below zero', () => {
    const warm = parse(telem(5, [0x03, PDU_FLAG.TEMP_WARN, ...le(235), ...le(2500), ...le(800)]))
    expect(warm).toEqual({
      nodeId: 5,
      kind: 'status',
      page: TELEM_PAGE.PDU_STATUS,
      flags: PDU_FLAG.TEMP_WARN,
      ntcTempC: 23.5,
      i12PeakMa: 2500,
      i5PeakMa: 800
    })
    const cold = parse(telem(5, [0x03, 0, ...le(-50 & 0xffff), 0, 0, 0, 0]))
    expect(cold).toMatchObject({ ntcTempC: -5 })
  })

  it('reports 0x8000 temperature as unavailable, not -3276.8 °C', () => {
    const t = parse(telem(5, [0x03, PDU_FLAG.NTC_FAULT, 0x00, 0x80, 0, 0, 0, 0]))
    expect(t).toMatchObject({ ntcTempC: null, flags: PDU_FLAG.NTC_FAULT })
  })

  it('passes an unknown page through undecoded', () => {
    expect(parseNodeTelem('0a7F0102030405060a'.toUpperCase())).toEqual({
      nodeId: 10,
      kind: 'unknown',
      page: 0x7f,
      body: '0102030405060a'
    })
  })

  it('INT16_MIN rail current is a real reading, not the temperature sentinel', () => {
    const t = parse(telem(3, [0x01, 0, ...le(12000), ...le(12000), 0x00, 0x80]))
    expect(t).toMatchObject({ kind: 'rail', iAvgMa: -32768 })
  })

  it('u16 fields are unsigned up to 65535', () => {
    const t = parse(telem(3, [0x02, 0, 0xff, 0xff, 0xff, 0xff, 0, 0]))
    expect(t).toMatchObject({ vAvgMv: 65535, vMinMv: 65535 })
    const s = parse(telem(5, [0x03, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]))
    expect(s).toMatchObject({ i12PeakMa: 65535, i5PeakMa: 65535 })
  })

  it('temperature unavailable does not depend on NTC_FAULT (boot, before the first sample)', () => {
    const t = parse(telem(5, [0x03, 0x00, 0x00, 0x80, 0, 0, 0, 0]))
    expect(t).toMatchObject({ flags: 0, ntcTempC: null })
  })

  it('rejects odd-length, 0x-prefixed and space-split hex', () => {
    expect(parseNodeTelem('030100E02E182EBC0')).toBeNull() // 17 chars
    expect(parseNodeTelem('0x030100E02E182EBC02')).toBeNull()
    expect(parseNodeTelem('0301 00E02E182EBC0')).toBeNull() // 18 chars with a space
    expect(parseNodeTelem(' 030100E02E182EBC02')).toBeNull() // the caller trims, not the decoder
  })

  it('rejects page 0, bad length, non-hex and out-of-range node ids', () => {
    expect(parseNodeTelem(telem(3, [0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(parseNodeTelem('030101022fae2ef4')).toBeNull()
    expect(parseNodeTelem('030101022fae2ef4ff00')).toBeNull()
    expect(parseNodeTelem('030101022fae2ef4fg')).toBeNull()
    expect(parseNodeTelem(telem(0, [1, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(parseNodeTelem(telem(64, [1, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('displayCurrentMa', () => {
  it('clamps residual negative offset to 0', () => {
    expect(displayCurrentMa(-12)).toBe(0)
    expect(displayCurrentMa(0)).toBe(0)
    expect(displayCurrentMa(1830)).toBe(1830)
  })
})

describe('NodeTelemStore', () => {
  const rail12 = (nodeId: number, mv: number) =>
    parse(telem(nodeId, [0x01, 0, ...le(mv), ...le(mv), 0, 0]))
  const status = (nodeId: number) => parse(telem(nodeId, [0x03, 0, ...le(300), 0, 0, 0, 0]))

  it('keeps the latest value per (node, page), with its age', () => {
    const s = new NodeTelemStore()
    s.apply(rail12(3, 12000), 1000)
    s.apply(rail12(3, 12100), 2000)
    s.apply(status(3), 2500)
    const [n] = s.snapshot(3000)
    expect(n).toMatchObject({ nodeId: 3, isPdu: true, live: true })
    expect(n?.rail12V).toMatchObject({ vAvgMv: 12100, ageMs: 1000, stale: false })
    expect(n?.status).toMatchObject({ ntcTempC: 30, ageMs: 500 })
    expect(n?.rail5V).toBeUndefined()
  })

  it('marks a page stale past TELEM_STALE_MS but keeps its last values', () => {
    const s = new NodeTelemStore()
    s.apply(rail12(3, 12000), 0)
    const [n] = s.snapshot(TELEM_STALE_MS + 1)
    expect(n?.rail12V).toMatchObject({ vAvgMv: 12000, stale: true })
    expect(n?.live).toBe(false)
    expect(s.snapshot(TELEM_STALE_MS)[0]?.live).toBe(true)
  })

  it('a node sending only unknown pages is not a PDU', () => {
    const s = new NodeTelemStore()
    s.apply(parse('0a7f0102030405060a'), 0)
    const [n] = s.snapshot(0)
    expect(n).toMatchObject({ nodeId: 10, isPdu: false, live: true })
    expect(n?.other).toHaveLength(1)
  })

  it('reports a change on new data and on a stale transition, not on ageing alone', () => {
    const s = new NodeTelemStore()
    expect(s.takeChanged(0)).toBe(false)
    s.apply(rail12(3, 12000), 0)
    expect(s.takeChanged(100)).toBe(true)
    expect(s.takeChanged(5000)).toBe(false) // older, still fresh
    expect(s.takeChanged(TELEM_STALE_MS + 1)).toBe(true) // went stale
    expect(s.takeChanged(TELEM_STALE_MS + 5000)).toBe(false)
    s.apply(rail12(3, 12000), TELEM_STALE_MS + 6000)
    expect(s.takeChanged(TELEM_STALE_MS + 6000)).toBe(true) // fresh again
  })

  it('reset clears everything and counts as a change', () => {
    const s = new NodeTelemStore()
    s.apply(rail12(3, 12000), 0)
    s.takeChanged(0)
    s.reset()
    expect(s.snapshot(0)).toEqual([])
    expect(s.takeChanged(0)).toBe(true)
  })
})

describe('hasFreshPduPage', () => {
  const unknown = parse('0a7f0102030405060a')
  it('is true only for a fresh 12 V, 5 V or status page', () => {
    const s = new NodeTelemStore()
    s.apply(parse(telem(3, [0x02, 0, 0, 0, 0, 0, 0, 0])), 0)
    expect(hasFreshPduPage(s.snapshot(TELEM_STALE_MS)[0]!)).toBe(true)
    s.apply({ ...unknown, nodeId: 3 }, TELEM_STALE_MS + 5000) // a newer page type, fresh
    const [n] = s.snapshot(TELEM_STALE_MS + 5000)
    expect(n?.live).toBe(true)
    expect(hasFreshPduPage(n!)).toBe(false) // the PDU page itself is stale
    const other = new NodeTelemStore()
    other.apply(unknown, 0)
    expect(hasFreshPduPage(other.snapshot(0)[0]!)).toBe(false)
  })
})
