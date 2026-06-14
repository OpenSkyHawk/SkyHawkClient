// Turns raw DCS-BIOS writes into named log rows, aircraft state, and the five
// sim-telemetry readouts — using the generated A-4E-C reference.
import { A4EC_OUTPUTS_BY_ADDRESS } from './reference/a4ec-controls.generated'
import { A4EC_ADDRESS_RANGE } from './reference/dcsbios-metadata'
import { StringRegion, ACFT_NAME_ADDRESS, ACFT_NAME_MAX } from '@shared/dcsbios'
import type { AircraftStatus, LogRow, TelemetryReadout } from '@shared/ipc'

interface TelemetrySpec {
  id: string
  label: string
  unit: string
}

const TELEMETRY: TelemetrySpec[] = [
  { id: 'RPM', label: 'RPM', unit: '% RPM' },
  { id: 'D_IAS_DEG', label: 'IAS', unit: 'KNOTS' },
  { id: 'D_FLAPS_IND', label: 'Flap', unit: '% DN' },
  { id: 'D_ALT_NEEDLE', label: 'Press Alt', unit: 'FEET' },
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
  private lastName = ''
  private sawA4ecAddress = false
  private aircraftDirty = true

  constructor() {
    for (const t of TELEMETRY) this.telemetry.set(t.id, NaN)
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
    return { name: 'NONE', inferred: false, supported: true }
  }

  telemetrySnapshot(): TelemetryReadout[] {
    return TELEMETRY.map((t) => {
      const value = this.telemetry.get(t.id) ?? NaN
      const max = this.telemetryMax.get(t.id) ?? 0xffff
      const pct = Number.isNaN(value) ? 0 : Math.max(0, Math.min(1, value / max))
      return { id: t.id, label: t.label, value, pct, unit: t.unit }
    })
  }
}
