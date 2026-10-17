// Cockpit health band presentation (R3.2): the PSU headroom bars and the plan's PSU box name. The
// counts, totals and CAN card are main's (cockpit:snapshot); the PSU setting is still read here
// until SettingsService resolves it (R3.3).
import type { PsuSetting } from '@shared/nodes'
import { PSU_PRESETS } from '@shared/nodes/legacy-rules'

/** A band value drawn against a PSU limit (Settings › Cockpit › Power supply). Display only. */
export interface Headroom {
  limit: number
  /** Share of the limit in use, not capped (112 = over). null = no reading. */
  pct: number | null
  /** Bar fill, 0–100. */
  bar: number
}

/** null = the limit is unknown: the card shows its plain total. */
export function headroom(value: number | null, limit: number | undefined): Headroom | null {
  if (limit === undefined) return null
  const pct = value === null ? null : (value / limit) * 100
  return { limit, pct, bar: pct === null ? 0 : Math.min(100, Math.max(0, pct)) }
}

/** What the plan's PSU box is called: the preset's model, or plain `PSU` for a custom supply. */
export function psuName(psu: PsuSetting): string {
  return psu.mode === 'preset' ? PSU_PRESETS[psu.preset].label : 'PSU'
}
