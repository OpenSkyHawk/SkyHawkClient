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
    expect(ac?.name).toBe('A-4E')
    expect(ac?.inferred).toBe(false)
    expect(ac?.supported).toBe(true)
  })

  it('infers A-4E-C from the address range when no name seen', () => {
    const d = new Decoder()
    d.handle(0x8400, 0x1234, 0)
    const ac = d.aircraft()
    expect(ac?.name).toBe('A-4E-C')
    expect(ac?.inferred).toBe(true)
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
