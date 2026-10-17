// Turns raw DCS-BIOS writes into named log rows, aircraft state, and the five
// sim-telemetry readouts — using the generated A-4E-C reference.
import { A4EC_OUTPUTS_BY_ADDRESS } from '@shared/firmware'
import { A4EC_ADDRESS_RANGE, StringRegion, ACFT_NAME_ADDRESS, ACFT_NAME_MAX } from './bios-protocol'
import {
  AIRCRAFT_NONE,
  type AircraftStatus,
  type GaugeTone,
  type LogRow,
  type TelemetryReadout
} from '@shared/dcs'

interface TelemetrySpec {
  id: string
  label: string
  unit: string
}

/**
 * A gauge ring's alert level (Overview.tsx gaugeColor before R3.3): fuel goes to its alert under
 * 25 %; the flap and altitude rings are the secondary ones. Keyed on the readout's id, so the idle
 * placeholders (X10: `D_ALT_NEEDLE`, not `ALT_FT`) keep the plain ring they had.
 */
export function gaugeTone(id: string, pct: number): GaugeTone {
  if (id === 'D_FUEL') return pct < 0.25 ? 'fuel-low' : 'fuel'
  return id === 'D_FLAPS_IND' || id === 'ALT_FT' ? 'secondary' : 'primary'
}

/**
 * The idle gauges (value NaN -> "—") the renderer shows until live telemetry arrives — the
 * decoder's idle variant, moved from the renderer's store (X10). Its ids, labels and units
 * drifted from the live readouts below (TELEMETRY): IAS and Press Alt read `% FS`, and Press Alt
 * keys on `D_ALT_NEEDLE`. Each surface keeps its own until the X10 fix: the renderer starts from
 * the contract's TELEMETRY_IDLE, which is this (main/dcs/sim-telemetry-decoder.test.ts).
 */
const IDLE_TELEMETRY: TelemetrySpec[] = [
  { id: 'RPM', label: 'RPM', unit: '% RPM' },
  { id: 'D_IAS_DEG', label: 'IAS', unit: '% FS' },
  { id: 'D_FLAPS_IND', label: 'Flap', unit: '% DN' },
  { id: 'D_ALT_NEEDLE', label: 'Press Alt', unit: '% FS' },
  { id: 'D_FUEL', label: 'Fuel', unit: '% QTY' }
]

/** The idle readouts: NaN values ("—"), empty rings, each with its ring's level. */
export function idleTelemetry(): TelemetryReadout[] {
  return IDLE_TELEMETRY.map((t) => ({ ...t, value: NaN, pct: 0, tone: gaugeTone(t.id, 0) }))
}

// Three altimeter drum addresses encode digit positions 0–9.999 as 0–65535.
// ALT_FT is a virtual telemetry id computed from them; it has no DCS-BIOS address.
const ALT_DRUM_IDS = new Set(['D_ALT_10K', 'D_ALT_1K', 'D_ALT_100S'])
const ALT_FT_MAX = 50_000

// Piecewise-linear IAS calibration: [raw, knots] pairs derived from A-4E gauge face.
// The pitot-static scale is nonlinear (angle ∝ v²); raw=0 is init/parked (0 kt).
// Tunable — fly at known speeds and update the table as needed.
const IAS_KT_LUT: [number, number][] = [
  [0, 0],
  [5461, 80],
  [10923, 120],
  [16384, 150],
  [24576, 200],
  [32768, 300],
  [40960, 400],
  [46432, 500],
  [49152, 600]
]
const IAS_MAX_KT = 600

function iasRawToKnots(raw: number): number {
  const lut = IAS_KT_LUT
  if (raw <= lut[0][0]) return lut[0][1]
  if (raw >= lut[lut.length - 1][0]) return lut[lut.length - 1][1]
  for (let i = 1; i < lut.length; i++) {
    if (raw <= lut[i][0]) {
      const [r0, k0] = lut[i - 1]
      const [r1, k1] = lut[i]
      return k0 + ((raw - r0) / (r1 - r0)) * (k1 - k0)
    }
  }
  return NaN
}

const TELEMETRY: TelemetrySpec[] = [
  { id: 'RPM', label: 'RPM', unit: '% RPM' },
  { id: 'D_IAS_DEG', label: 'IAS', unit: 'kt' },
  { id: 'D_FLAPS_IND', label: 'Flap', unit: '% DN' },
  { id: 'ALT_FT', label: 'Press Alt', unit: 'ft' },
  { id: 'D_FUEL', label: 'Fuel', unit: '% QTY' }
]

/** Extract the field value from a 16-bit word per the output's mask/shift. */
export function extractValue(raw: number, mask: number, shift: number): number {
  if (mask === 0) return raw & 0xffff
  return (raw & mask) >> shift
}

function isA4E(name: string): boolean {
  return /a-?4e/i.test(name)
}

export class Decoder {
  private readonly name = new StringRegion(ACFT_NAME_ADDRESS, ACFT_NAME_MAX)
  private readonly telemetry = new Map<string, number>() // id -> latest value
  private readonly telemetryMax = new Map<string, number>()
  private readonly altDrums = new Map<string, number>() // D_ALT_10K/1K/100S raw values
  private lastName = ''
  private sawA4ecAddress = false
  private aircraftDirty = true

  constructor() {
    for (const t of TELEMETRY) {
      if (t.id !== 'ALT_FT') this.telemetry.set(t.id, NaN)
    }
  }

  /** Apply one write; returns the decoded log rows it produced (may be empty). */
  handle(address: number, raw: number, t: number): LogRow[] {
    if (this.name.update(address, raw)) {
      const n = this.name.value()
      if (n !== this.lastName) {
        this.lastName = n
        this.aircraftDirty = true
      }
    }
    if (address >= A4EC_ADDRESS_RANGE.start && address <= A4EC_ADDRESS_RANGE.end) {
      if (!this.sawA4ecAddress) {
        this.sawA4ecAddress = true
        this.aircraftDirty = true
      }
    }

    const outputs = A4EC_OUTPUTS_BY_ADDRESS.get(address)
    if (!outputs) return []

    const rows: LogRow[] = []
    for (const o of outputs) {
      const value = extractValue(raw, o.mask, o.shift)
      rows.push({ t, dir: 'in', address, name: o.id, value })
      if (this.telemetry.has(o.id)) {
        this.telemetry.set(o.id, value)
        this.telemetryMax.set(o.id, o.max > 0 ? o.max : 0xffff)
      }
      if (ALT_DRUM_IDS.has(o.id)) {
        this.altDrums.set(o.id, value)
      }
    }
    return rows
  }

  /** Current aircraft state if it changed since the last call, else null. */
  aircraft(): AircraftStatus | null {
    if (!this.aircraftDirty) return null
    this.aircraftDirty = false
    if (this.lastName && this.lastName.toUpperCase() !== 'NONE') {
      return { name: this.lastName, inferred: false, supported: isA4E(this.lastName) }
    }
    if (this.sawA4ecAddress) {
      return { name: 'A-4E-C', inferred: true, supported: true }
    }
    return { ...AIRCRAFT_NONE }
  }

  telemetrySnapshot(): TelemetryReadout[] {
    return TELEMETRY.map((t) => {
      if (t.id === 'D_IAS_DEG') {
        const raw = this.telemetry.get('D_IAS_DEG') ?? NaN
        const kt = Number.isNaN(raw) ? NaN : iasRawToKnots(raw)
        const pct = Number.isNaN(kt) ? 0 : Math.max(0, Math.min(1, kt / IAS_MAX_KT))
        return {
          id: 'D_IAS_DEG',
          label: t.label,
          value: kt,
          pct,
          unit: t.unit,
          tone: gaugeTone('D_IAS_DEG', pct)
        }
      }
      if (t.id === 'ALT_FT') {
        const d10k = this.altDrums.get('D_ALT_10K')
        const d1k = this.altDrums.get('D_ALT_1K')
        const d100s = this.altDrums.get('D_ALT_100S')
        const alt =
          d10k !== undefined && d1k !== undefined && d100s !== undefined
            ? Math.floor((d10k / 65535) * 10) * 10000 +
              Math.floor((d1k / 65535) * 10) * 1000 +
              Math.floor((d100s / 65535) * 10) * 100
            : NaN
        const pct = Number.isNaN(alt) ? 0 : Math.max(0, Math.min(1, alt / ALT_FT_MAX))
        return {
          id: 'ALT_FT',
          label: t.label,
          value: alt,
          pct,
          unit: t.unit,
          tone: gaugeTone('ALT_FT', pct)
        }
      }
      const raw = this.telemetry.get(t.id) ?? NaN
      const max = this.telemetryMax.get(t.id) ?? 0xffff
      const pct = Number.isNaN(raw) ? 0 : Math.max(0, Math.min(1, raw / max))
      const value = Number.isNaN(raw) ? NaN : Math.round(pct * 100)
      return { id: t.id, label: t.label, value, pct, unit: t.unit, tone: gaugeTone(t.id, pct) }
    })
  }
}

/** The two pushes the telemetry tick makes. */
interface TelemetryEmit {
  (channel: 'telemetry:tick', payload: TelemetryReadout[]): void
  (channel: 'aircraft:changed', payload: AircraftStatus): void
}

/** The telemetry tick: the five readouts, then the aircraft if it changed since the last tick. */
export function flushTelemetry(decoder: Decoder, emit: TelemetryEmit): void {
  emit('telemetry:tick', decoder.telemetrySnapshot())
  const ac = decoder.aircraft()
  if (ac) emit('aircraft:changed', ac)
}
