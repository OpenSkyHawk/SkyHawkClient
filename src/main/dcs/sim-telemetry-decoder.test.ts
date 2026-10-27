import { describe, expect, it } from 'vitest'
import { A4EC_OUTPUTS } from '@shared/firmware'
import { TELEMETRY_IDLE } from '@shared/dcs'
import { Decoder, extractValue, gaugeTone, idleTelemetry } from './sim-telemetry-decoder'

describe('extractValue', () => {
  it('masks and shifts', () => {
    expect(extractValue(0xff00, 0xff00, 8)).toBe(0xff)
    expect(extractValue(0b0000_1100, 0b0000_1100, 2)).toBe(0b11)
  })
  it('returns the raw word when mask is 0', () => {
    expect(extractValue(0x1234, 0, 0)).toBe(0x1234)
  })
})

describe('Decoder aircraft tracking', () => {
  it('reads _ACFT_NAME from the metadata string region', () => {
    const d = new Decoder()
    d.handle(0x0000, 'A'.charCodeAt(0) | ('-'.charCodeAt(0) << 8), 0)
    d.handle(0x0002, '4'.charCodeAt(0) | ('E'.charCodeAt(0) << 8), 0)
    d.handle(0x0004, 0, 0)
    const ac = d.aircraft()
    expect(ac).toEqual({ name: 'A-4E', supported: true })
  })

  /** Write `name` into the _ACFT_NAME string region, two characters per word, NUL-ended. */
  const writeName = (d: Decoder, name: string) => {
    const bytes = [...name].map((c) => c.charCodeAt(0)).concat(0)
    for (let i = 0; i < bytes.length; i += 2) d.handle(i, bytes[i]! | ((bytes[i + 1] ?? 0) << 8), 0)
  }

  // #172: modules share address space. In DCS-BIOS v0.11.8 the AH-64D's outputs span
  // 0x8000–0x87AB and the MB-339's reach 0x8417, both over the A-4E's 0x8400–0x8555.
  it('never guesses from addresses: an AH-64D stream with no name yet is NONE, not the A-4E', () => {
    const d = new Decoder()
    for (const a of [0x8000, 0x8400, 0x8452, 0x8554, 0x87ab]) d.handle(a, 0x1234, 0)
    expect(d.aircraft()).toEqual({ name: 'NONE', supported: true })
  })

  it('_ACFT_NAME wins: the AH-64D is named, and warned about, over the A-4E addresses it writes', () => {
    const d = new Decoder()
    d.handle(0x8400, 0x1234, 0)
    writeName(d, 'AH-64D_BLK_II')
    expect(d.aircraft()).toEqual({ name: 'AH-64D_BLK_II', supported: false })
  })

  it('returns null when nothing changed', () => {
    const d = new Decoder()
    d.aircraft() // consume initial
    expect(d.aircraft()).toBeNull()
  })
})

describe('Decoder telemetry', () => {
  it('exposes the five readouts', () => {
    const ids = new Decoder().telemetrySnapshot().map((r) => r.id)
    expect(ids).toEqual(['RPM', 'D_IAS_DEG', 'D_FLAPS_IND', 'ALT_FT', 'D_FUEL'])
  })
})

describe('the gauges’ alert level (Overview.tsx gaugeColor before R3.3)', () => {
  it('fuel goes to its alert under 25 %; flap and altitude are the secondary rings', () => {
    expect(gaugeTone('D_FUEL', 0.25)).toBe('fuel')
    expect(gaugeTone('D_FUEL', 0.24)).toBe('fuel-low')
    expect(gaugeTone('D_FLAPS_IND', 0.5)).toBe('secondary')
    expect(gaugeTone('ALT_FT', 0)).toBe('secondary')
    expect(gaugeTone('RPM', 0.9)).toBe('primary')
  })

  it('X10: one spec — the idle readouts are the live ones with nothing decoded', () => {
    expect(idleTelemetry()).toEqual(TELEMETRY_IDLE)
    const live = new Decoder().telemetrySnapshot()
    expect(idleTelemetry()).toEqual(live)
    // Real units from the start: IAS in kt, Press Alt in ft (its secondary ring), never % FS.
    expect(TELEMETRY_IDLE.map((r) => r.unit)).toEqual(['% RPM', 'kt', '% DN', 'ft', '% QTY'])
    expect(TELEMETRY_IDLE[3]).toMatchObject({ id: 'ALT_FT', tone: 'secondary' })
  })

  it('X10: the first frame keeps the idle ids, labels and units', () => {
    const d = new Decoder()
    d.handle(A4EC_OUTPUTS.find((o) => o.id === 'RPM')!.address, 0x8000, 0)
    const first = d.telemetrySnapshot()
    const spec = (r: { id: string; label: string; unit: string }) => [r.id, r.label, r.unit]
    expect(first.map(spec)).toEqual(TELEMETRY_IDLE.map(spec))
    expect(first[0]!.value).not.toBeNaN()
  })
})
