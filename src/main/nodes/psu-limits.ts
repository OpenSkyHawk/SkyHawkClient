// Power supply limits (#67) the Cockpit headroom is drawn against (#63). Pure; persisted in
// config.json as AppConfig.psu. Display only — the client never alerts on them.

import { DEFAULT_PSU, type PsuLimits, type PsuPresetId, type PsuSetting } from '@shared/nodes'
import { isLimit, PSU_PRESETS } from '@shared/nodes/legacy-rules'

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
