// Power supply limits (#67) the Cockpit headroom is drawn against (#63). Pure; persisted in
// config.json as AppConfig.psu. Display only — the client never alerts on them.

/** Rail limits as printed on a PSU label. Absent = unknown: the Cockpit shows plain totals. */
export interface PsuLimits {
  /** Combined current of all 12 V outputs, A. */
  a12?: number
  /** Combined current of all 5 V outputs, A. */
  a5?: number
  /** Rated output, W. */
  w?: number
}

export type PsuPresetId = 'nx650'

export interface PsuPreset {
  /** Short label for the segmented control. */
  label: string
  /** Full name, shown under the limits. */
  name: string
  limits: PsuLimits
}

/** Supplies bundled with the client. Limits are read-only in Settings. */
export const PSU_PRESETS: Record<PsuPresetId, PsuPreset> = {
  // GOLDEN FIELD NX650 — the project's supply. From its spec: +12 V 54 A, +5 V 20 A, 650 W.
  // (+3.3 V and +5 V share 100 W combined; the Cockpit shows no 3.3 V rail, so that is left out.)
  nx650: { label: 'NX650', name: 'GOLDEN FIELD NX650', limits: { a12: 54, a5: 20, w: 650 } }
}

export interface PsuSetting {
  mode: 'preset' | 'custom'
  preset: PsuPresetId
  /** Kept while a preset is picked, so switching back to Custom restores what was entered. */
  custom: PsuLimits
}

export const DEFAULT_PSU: PsuSetting = { mode: 'preset', preset: 'nx650', custom: {} }

/** Largest value accepted for any limit; anything above is a typo, not a desktop PSU. */
export const PSU_LIMIT_MAX = 10000

const isLimit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= PSU_LIMIT_MAX

function sanitizeLimits(raw: unknown): PsuLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: PsuLimits = {}
  for (const k of ['a12', 'a5', 'w'] as const) if (isLimit(r[k])) out[k] = r[k]
  return out
}

const isPreset = (v: unknown): v is PsuPresetId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(PSU_PRESETS, v)

/** Tolerant read: anything malformed falls back to its default, field by field. */
export function sanitizePsu(raw: unknown): PsuSetting {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    mode: p.mode === 'custom' || p.mode === 'preset' ? p.mode : DEFAULT_PSU.mode,
    preset: isPreset(p.preset) ? p.preset : DEFAULT_PSU.preset,
    custom: sanitizeLimits(p.custom)
  }
}

/** The limits the Cockpit should use: the preset's, or what was entered. */
export function effectivePsuLimits(psu: PsuSetting): PsuLimits {
  return psu.mode === 'preset' ? PSU_PRESETS[psu.preset].limits : psu.custom
}

/**
 * Parse one limit as typed. Empty means "unknown" (undefined); anything that is not a positive
 * number up to PSU_LIMIT_MAX is refused (null), so the field can show it and nothing is saved.
 */
export function parsePsuLimit(text: string): number | undefined | null {
  const t = text.trim()
  if (!t) return undefined
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return isLimit(n) ? n : null
}
