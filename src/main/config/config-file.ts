// Configuration export / import (#67): one JSON file with this client's setup, and the review of
// what importing one would change. Pure — main does the dialogs and the writes.
//
// Four sections, each the same shape as its store. An import reads each one STRICTLY (C1): the
// section must carry its store's structural markers, or it is rejected — listed as skipped in the
// review with the reason — and never read as an intentionally empty or default setting. Only then
// is it read back through that store's own tolerant sanitizer, so a file can never put anything
// into a store that the store itself would refuse. (The app's own files keep their tolerant read.)
//   section      store                         strict read: its markers
//   app          config.json without the PSU   checkImportedApp: every setting, each valid
//   nodeMapping  node-mapping.json             checkImportedMapping: `version`, `nodes`
//   powerSupply  config.json › psu             checkImportedPsu: `mode`, `preset`, `custom`
//   calibration  calibration-cache.json        checkImportedCache: `version`, `boards`, and per
//                                              board `confirmedAt` and `axes`
// Calibration only ever refills the client's copy. Writing a device is the HID tab's Review &
// restore offer, never an import.
import { sanitizeConfig } from './settings-schema'
import {
  CONFIG_FORMAT,
  type AppConfig,
  type AppSettings,
  type ConfigFile,
  type ConfigSnapshot,
  type DiffRow,
  type ImportPreview,
  type RejectedSection,
  type SectionDiff,
  type SectionId
} from '@shared/config'
import type { CachedAxis, CalCache } from '@shared/hid/calibration'
import type { MappedNode, NodeDefaults, NodeMappingFile, PsuSetting } from '@shared/nodes'
import { onOff, plural, PSU_LIMITS } from '@shared/format'
import { checkImportedCache } from '../hid/calibration'
import {
  checkImportedMapping,
  checkImportedPsu,
  effectiveMapping,
  importMapping,
  inCockpit,
  isPlainObject,
  PSU_PRESETS
} from '../nodes'

/** File format this build writes. A higher version came from a newer client. */
const CONFIG_FILE_VERSION = 1

export const SECTION_IDS: SectionId[] = ['app', 'nodeMapping', 'powerSupply', 'calibration']

export const SECTION_TITLES: Record<SectionId, string> = {
  app: 'App settings',
  nodeMapping: 'Node mapping',
  powerSupply: 'Power supply',
  calibration: 'Axis calibration'
}

/** Split AppConfig into its two sections. */
export function appSettings(config: AppConfig): AppSettings {
  const { psu: _psu, ...app } = config
  return app
}

export function buildConfigFile(
  current: ConfigSnapshot,
  exportedAt: string,
  client: string
): ConfigFile {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_FILE_VERSION,
    exportedAt,
    client,
    sections: current
  }
}

export interface ParsedConfig {
  version: number
  exportedAt?: string
  client?: string
  sections: Partial<ConfigSnapshot>
  /** Section keys this client does not know (a newer client's), left out of the import. */
  skipped: string[]
  /** Sections this client knows that are malformed or incomplete (C1), left out, with why. */
  rejected: { id: SectionId; reason: string }[]
}

export type ParseResult = { ok: true; config: ParsedConfig } | { ok: false; error: string }

const NOT_CONFIG = 'This is not an OpenSkyhawk Client configuration file.'

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * The app section, read strictly (C1): every setting AppSettings has must be present and hold a
 * value config.json's own sanitizer keeps — one it would replace with its default is malformed,
 * since `app: {}` must not read as "reset to defaults". A key a newer client added is ignored.
 */
function checkImportedApp(raw: unknown): Checked<AppSettings> {
  if (!isPlainObject(raw)) return { ok: false, reason: 'it is not a settings section' }
  const read = appSettings(sanitizeConfig({ ...raw, psu: undefined }))
  for (const f of APP_FIELDS) {
    if (!(f.key in raw)) return { ok: false, reason: `it has no “${f.label}” setting` }
    if (raw[f.key] !== read[f.key]) {
      return { ok: false, reason: `its “${f.label}” setting is not valid` }
    }
  }
  return { ok: true, value: read }
}

/** Each known section's strict read. */
const CHECK: { [K in SectionId]: (raw: unknown) => Checked<ConfigSnapshot[K]> } = {
  app: checkImportedApp,
  nodeMapping: checkImportedMapping,
  powerSupply: checkImportedPsu,
  calibration: checkImportedCache
}

/**
 * Read an exported file. Anything that is not one is refused whole (nothing changes); a file from
 * a newer client is read for the sections this client knows, and the rest are listed as skipped.
 * A known section that is malformed or incomplete is rejected with its reason (C1); a file with
 * no section left to import is refused, and says why each known one was rejected.
 */
export function parseConfigFile(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: `${NOT_CONFIG} It is not valid JSON.` }
  }
  if (!isPlainObject(raw) || raw.format !== CONFIG_FORMAT) return { ok: false, error: NOT_CONFIG }
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: `${NOT_CONFIG} Its version is missing.` }
  }
  if (!isPlainObject(raw.sections)) return { ok: false, error: `${NOT_CONFIG} It has no sections.` }

  const sections: Partial<ConfigSnapshot> = {}
  const skipped: string[] = []
  const rejected: ParsedConfig['rejected'] = []
  for (const [key, value] of Object.entries(raw.sections)) {
    if (!(SECTION_IDS as string[]).includes(key)) {
      skipped.push(key)
      continue
    }
    const id = key as SectionId
    const r = CHECK[id](value)
    if (r.ok) (sections as Record<SectionId, unknown>)[id] = r.value
    else rejected.push({ id, reason: r.reason })
  }
  if (SECTION_IDS.every((id) => sections[id] === undefined)) {
    const why = rejected.map((r) => ` ${SECTION_TITLES[r.id]}: ${r.reason}.`).join('')
    return { ok: false, error: `This file has no settings this client can read.${why}` }
  }
  const config: ParsedConfig = { version, sections, skipped, rejected }
  if (typeof raw.exportedAt === 'string') config.exportedAt = raw.exportedAt
  if (typeof raw.client === 'string') config.client = raw.client
  return { ok: true, config }
}

// ── review: what applying a section would change ─────────────────────────────

const APP_FIELDS: { key: keyof AppSettings; label: string; show?: (v: never) => string }[] = [
  { key: 'sourceMode', label: 'Source mode' },
  { key: 'transport', label: 'DCS transport' },
  { key: 'host', label: 'DCS host' },
  { key: 'commandPort', label: 'Command port' },
  { key: 'listenPort', label: 'Listen port' },
  { key: 'autoConnect', label: 'Connect automatically', show: onOff },
  { key: 'replayDriveSerial', label: 'Replay drives the Gateway', show: onOff },
  { key: 'debugMode', label: 'Debug logging', show: onOff },
  { key: 'attentionBanner', label: 'Attention banner', show: onOff }
]

function diffApp(cur: AppSettings, next: AppSettings): DiffRow[] {
  const rows: DiffRow[] = []
  for (const f of APP_FIELDS) {
    if (cur[f.key] === next[f.key]) continue
    const show = (v: unknown) => (f.show ? f.show(v as never) : String(v))
    rows.push({ k: f.label, from: show(cur[f.key]), to: show(next[f.key]) })
  }
  return rows
}

function diffPsu(cur: PsuSetting, next: PsuSetting): DiffRow[] {
  const name = (p: PsuSetting) =>
    p.mode === 'preset' ? `${PSU_PRESETS[p.preset].label} preset` : 'Custom'
  const rows: DiffRow[] = []
  if (name(cur) !== name(next)) rows.push({ k: 'PSU', from: name(cur), to: name(next) })
  // Custom limits are kept while a preset is picked, so they are compared either way.
  for (const l of PSU_LIMITS) {
    const a = cur.custom[l.key]
    const b = next.custom[l.key]
    if (a === b) continue
    const show = (v?: number) => (v === undefined ? '—' : `${v} ${l.unit}`)
    rows.push({
      k: `Custom ${l.label.charAt(0).toLowerCase()}${l.label.slice(1)}`,
      from: show(a),
      to: show(b)
    })
  }
  return rows
}

/** "· 1 joins · 2 leave": the heading's count of boards entering and leaving your cockpit (S4). */
function membershipSummary(joins: number, leaves: number): string {
  let out = ''
  if (joins) out += ` · ${joins} ${joins === 1 ? 'joins' : 'join'}`
  if (leaves) out += ` · ${leaves} ${leaves === 1 ? 'leaves' : 'leave'}`
  return out
}

function diffNodes(
  defaults: Map<number, NodeDefaults>,
  cur: NodeMappingFile,
  next: NodeMappingFile,
  online: number[]
): { rows: DiffRow[]; summary: string } {
  // What applying it would leave — the same importMapping the apply stages: membership as written
  // (D3), this computer's last-seen kept, and no hidden flag on a board on the bus or outside your
  // cockpit.
  const after = importMapping(cur, next, online)
  const a = effectiveMapping(defaults, cur)
  const b = effectiveMapping(defaults, after)
  const zone = (map: Map<number, MappedNode>, pduId: number | null) =>
    pduId === null ? '—' : (map.get(pduId)?.name ?? defaults.get(pduId)?.name ?? `Node ${pduId}`)
  const where = (map: Map<number, MappedNode>, m: MappedNode) =>
    `${m.console} · ${zone(map, m.pduId)}`
  const OUT = 'not in your cockpit'
  const place = (map: Map<number, MappedNode>, m?: MappedNode) =>
    m ? `${m.name} · ${where(map, m)}` : 'in your cockpit'
  const rows: DiffRow[] = []
  const changed = new Set<number>()
  let joins = 0
  let leaves = 0
  const ids = [
    ...new Set([
      ...a.keys(),
      ...b.keys(),
      ...Object.keys(cur.nodes).map(Number),
      ...Object.keys(after.nodes).map(Number)
    ])
  ].sort((x, y) => x - y)
  for (const id of ids) {
    const push = (k: string, from: string, to: string) => {
      rows.push({ k, from, to })
      changed.add(id)
    }
    const x = a.get(id)
    const y = b.get(id)
    const d = defaults.get(id)
    // Joining or leaving your cockpit, by the one membership rule (nodes/membership.ts): one row
    // with the whole placement, for a registry board or an adopted one alike.
    const wasIn = inCockpit(cur.nodes[id])
    const isIn = inCockpit(after.nodes[id])
    if (wasIn !== isIn) {
      push(d ? d.name : `#${id}`, wasIn ? place(a, x) : OUT, isIn ? place(b, y) : OUT)
      if (isIn) joins++
      else leaves++
      continue
    }
    if (!d) {
      // An adopted board staying in your cockpit: name, console and power zone together.
      if (wasIn && place(a, x) !== place(b, y)) push(`#${id}`, place(a, x), place(b, y))
      continue
    }
    if (!x || !y) continue
    if (x.name !== y.name) push(`${d.name} · name`, x.name, y.name)
    if (x.console !== y.console) push(`${d.name} · console`, x.console, y.console)
    if (zone(a, x.pduId) !== zone(b, y.pduId))
      push(`${d.name} · power zone`, zone(a, x.pduId), zone(b, y.pduId))
    if (x.hidden !== y.hidden)
      push(`${d.name} · hidden`, x.hidden ? 'yes' : 'no', y.hidden ? 'yes' : 'no')
  }
  return { rows, summary: plural(changed.size, 'node') + membershipSummary(joins, leaves) }
}

const axisText = (a?: CachedAxis) => (a ? `${a.min} · ${a.centre} · ${a.max}` : 'not in the copy')
const sameAxis = (a?: CachedAxis, b?: CachedAxis) =>
  !!a &&
  !!b &&
  a.min === b.min &&
  a.centre === b.centre &&
  a.max === b.max &&
  a.selfCentring === b.selfCentring

function diffCalibration(cur: CalCache, next: CalCache): { rows: DiffRow[]; boards: string[] } {
  const rows: DiffRow[] = []
  const boards: string[] = []
  for (const serial of Object.keys(next.boards).sort()) {
    const imported = next.boards[serial]!
    const cached = cur.boards[serial]
    let any = false
    for (const idx of Object.keys(imported.axes)
      .map(Number)
      .sort((x, y) => x - y)) {
      const from = cached?.axes[idx]
      const to = imported.axes[idx]!
      if (sameAxis(from, to)) continue
      rows.push({
        k: `Axis ${idx}`,
        from: axisText(from),
        to: axisText(to),
        axis: idx,
        board: serial
      })
      any = true
    }
    if (any) boards.push(serial)
  }
  return { rows, boards }
}

/** What each section in the file would change. A section that changes nothing has no rows. */
export function diffImport(
  defaults: Map<number, NodeDefaults>,
  current: ConfigSnapshot,
  imported: Partial<ConfigSnapshot>,
  /** Boards on the bus now (the node mapping section never hides one). */
  online: number[] = []
): SectionDiff[] {
  const out: SectionDiff[] = []
  for (const id of SECTION_IDS) {
    if (imported[id] === undefined) continue
    let rows: DiffRow[]
    let summary: string
    if (id === 'app') {
      rows = diffApp(current.app, imported.app!)
      summary = plural(rows.length, 'change')
    } else if (id === 'powerSupply') {
      rows = diffPsu(current.powerSupply, imported.powerSupply!)
      summary = plural(rows.length, 'change')
    } else if (id === 'nodeMapping') {
      const d = diffNodes(defaults, current.nodeMapping, imported.nodeMapping!, online)
      rows = d.rows
      summary = d.summary
    } else {
      const d = diffCalibration(current.calibration, imported.calibration!)
      rows = d.rows
      summary =
        d.boards.length === 1
          ? `${plural(rows.length, 'axis', 'axes')} · board ${d.boards[0]}`
          : `${plural(rows.length, 'axis', 'axes')} · ${plural(d.boards.length, 'board')}`
    }
    out.push({ id, title: SECTION_TITLES[id], summary, rows })
  }
  return out
}

/**
 * What applying the calibration section does, said in the review (ImportDialog.tsx before R3.3):
 * it adds to the client's copy and never writes to the device.
 */
const CAL_NOTE =
  'Adds these values to the client’s calibration copy — nothing is written to the device here. If the Gateway has lost calibration, the usual Review & restore offer appears on the HID tab; axes the device still holds are never overwritten.'

/** The review's sections with what applying each does, where it says (a changing calibration). */
export function withSectionNotes(sections: SectionDiff[]): SectionDiff[] {
  return sections.map((s) =>
    s.id === 'calibration' && s.rows.length > 0 ? { ...s, note: CAL_NOTE } : s
  )
}

/** The rejected sections as the review lists them: title and reason (C1). */
function rejectedSections(config: ParsedConfig): RejectedSection[] {
  return config.rejected.map((r) => ({ id: r.id, title: SECTION_TITLES[r.id], reason: r.reason }))
}

/**
 * The review of a parsed file against this computer's setup: what `config:import-open` answers.
 * Shared by ConfigTransfer.preview and the renderer tests' scenarios, so both build it one way.
 */
export function buildImportPreview(
  config: ParsedConfig,
  against: {
    defaults: Map<number, NodeDefaults>
    current: ConfigSnapshot
    /** Boards on the bus now (the node mapping section never hides one). */
    online: number[]
  },
  token: string,
  fileName: string
): ImportPreview {
  const sections = withSectionNotes(
    diffImport(against.defaults, against.current, config.sections, against.online)
  )
  return {
    token,
    fileName,
    ...(config.exportedAt ? { exportedAt: config.exportedAt } : {}),
    ...(config.client ? { client: config.client } : {}),
    sections,
    skipped: config.skipped,
    rejected: rejectedSections(config),
    identical: sections.every((s) => s.rows.length === 0)
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

/** The AppConfig after applying the picked sections of an import: PSU and the rest separately. */
export function applyToConfig(
  config: AppConfig,
  imported: Partial<ConfigSnapshot>,
  picked: ReadonlySet<SectionId>
): AppConfig {
  let next = config
  if (picked.has('app') && imported.app) next = { ...imported.app, psu: next.psu }
  if (picked.has('powerSupply') && imported.powerSupply)
    next = { ...next, psu: imported.powerSupply }
  return next
}
