// Power supply limits (#67) the Cockpit headroom is drawn against (#63). Pure; persisted in
// config.json as AppConfig.psu. Display only — the client never alerts on them. What a setting
// comes to — the preset, the limits, the PSU box's name — is resolved here and pushed with the
// settings (SettingsService, R3.3); the renderer only shows it.

import type { PsuView } from '@shared/config'
import {
  DEFAULT_PSU,
  isLimit,
  type PsuLimits,
  type PsuPreset,
  type PsuPresetId,
  type PsuSetting
} from '@shared/nodes'
import { PSU_LIMITS } from '@shared/format'

/** Supplies bundled with the client. Limits are read-only in Settings. */
export const PSU_PRESETS: Record<PsuPresetId, PsuPreset> = {
  // GOLDEN FIELD NX650 — the project's supply. From its spec: +12 V 54 A, +5 V 20 A, 650 W.
  // (+3.3 V and +5 V share 100 W combined; the Cockpit shows no 3.3 V rail, so that is left out.)
  nx650: { label: 'NX650', name: 'GOLDEN FIELD NX650', limits: { a12: 54, a5: 20, w: 650 } }
}

/** The limits the Cockpit should use: the preset's, or what was entered. */
export function effectivePsuLimits(psu: PsuSetting): PsuLimits {
  return psu.mode === 'preset' ? PSU_PRESETS[psu.preset].limits : psu.custom
}

/** What the plan's PSU box is called: the preset's model, or plain `PSU` for a custom supply. */
export function psuName(psu: PsuSetting): string {
  return psu.mode === 'preset' ? PSU_PRESETS[psu.preset].label : 'PSU'
}

/** What a setting comes to, for Settings › Cockpit and the Cockpit (`config:changed`). */
export function resolvePsu(psu: PsuSetting): PsuView {
  return { name: psuName(psu), limits: effectivePsuLimits(psu), preset: PSU_PRESETS[psu.preset] }
}

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A config import's power supply section, read strictly (C1): a local config.json is read
 * tolerantly (sanitizePsu: a bad field falls back to its default), but an import must never turn
 * a damaged section into the default supply. Its markers are the three fields every PsuSetting
 * has — `mode` (preset or custom), `preset` (one this client bundles) and `custom` (an object) —
 * and each limit the file sets must be a valid limit. `reason` completes "Power supply: …".
 */
export function checkImportedPsu(
  raw: unknown
): { ok: true; value: PsuSetting } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'it is not a settings section' }
  if (raw.mode !== 'preset' && raw.mode !== 'custom') {
    return { ok: false, reason: 'it does not say whether the supply is a preset or custom' }
  }
  if (!isPreset(raw.preset)) return { ok: false, reason: 'its preset is not one this client knows' }
  if (!isRecord(raw.custom)) return { ok: false, reason: 'it has no custom limits' }
  for (const l of PSU_LIMITS) {
    const v = raw.custom[l.key]
    if (v !== undefined && !isLimit(v)) {
      return {
        ok: false,
        reason: `its custom ${l.label.charAt(0).toLowerCase()}${l.label.slice(1)} is not valid`
      }
    }
  }
  return { ok: true, value: sanitizePsu(raw) }
}
