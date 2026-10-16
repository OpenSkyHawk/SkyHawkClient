// Configuration export / import (#67): one JSON file with this client's setup, and the review of
// what importing one would change. Pure — main does the dialogs and the writes.
//
// Four sections, each the same shape as its store and read back through that store's own
// sanitizer, so a file can never put anything into a store that the store itself would refuse:
//   app          config.json without the PSU          sanitizeConfig
//   nodeMapping  node-mapping.json                    sanitizeNodeMapping
//   powerSupply  config.json › psu                    sanitizePsu
//   calibration  calibration-cache.json               sanitizeCache
// Calibration only ever refills the client's copy. Writing a device is the HID tab's Review &
// restore offer, never an import.
import { DEFAULT_CONFIG, sanitizeConfig, type AppConfig } from './ipc'
import { sanitizeCache, type CachedAxis, type CalCache } from './cal-cache'
import {
  effectiveMapping,
  sanitizeNodeMapping,
  type MappedNode,
  type NodeDefaults,
  type NodeMappingFile
} from './node-mapping'
import { PSU_PRESETS, sanitizePsu, type PsuLimits, type PsuSetting } from './psu'

export const CONFIG_FORMAT = 'openskyhawk-client-config'
/** File format this build writes. A higher version came from a newer client. */
export const CONFIG_FILE_VERSION = 1

export type AppSettings = Omit<AppConfig, 'psu'>

export interface ConfigSnapshot {
  app: AppSettings
  nodeMapping: NodeMappingFile
  powerSupply: PsuSetting
  calibration: CalCache
}

export type SectionId = keyof ConfigSnapshot
export const SECTION_IDS: SectionId[] = ['app', 'nodeMapping', 'powerSupply', 'calibration']

export const SECTION_TITLES: Record<SectionId, string> = {
  app: 'App settings',
  nodeMapping: 'Node mapping',
  powerSupply: 'Power supply',
  calibration: 'Axis calibration'
}

export interface ConfigFile {
  format: typeof CONFIG_FORMAT
  version: number
  exportedAt: string
  /** Client version that wrote it. */
  client: string
  sections: Partial<ConfigSnapshot>
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
}

export type ParseResult = { ok: true; config: ParsedConfig } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const NOT_CONFIG = 'This is not an OpenSkyhawk Client configuration file.'

/**
 * Read an exported file. Anything that is not one is refused whole (nothing changes); a file from
 * a newer client is read for the sections this client knows, and the rest are listed as skipped.
 */
export function parseConfigFile(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: `${NOT_CONFIG} It is not valid JSON.` }
  }
  if (!isObject(raw) || raw.format !== CONFIG_FORMAT) return { ok: false, error: NOT_CONFIG }
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: `${NOT_CONFIG} Its version is missing.` }
  }
  if (!isObject(raw.sections)) return { ok: false, error: `${NOT_CONFIG} It has no sections.` }

  const sections: Partial<ConfigSnapshot> = {}
  const skipped: string[] = []
  for (const [key, value] of Object.entries(raw.sections)) {
    if (!isObject(value) || !(SECTION_IDS as string[]).includes(key)) {
      skipped.push(key)
      continue
    }
    const id = key as SectionId
    if (id === 'app') sections.app = appSettings(sanitizeConfig({ ...value, psu: undefined }))
    else if (id === 'nodeMapping') sections.nodeMapping = sanitizeNodeMapping(value)
    else if (id === 'powerSupply') sections.powerSupply = sanitizePsu(value)
    else sections.calibration = sanitizeCache(value)
  }
  if (SECTION_IDS.every((id) => sections[id] === undefined)) {
    return { ok: false, error: 'This file has no settings this client can read.' }
  }
  const config: ParsedConfig = { version, sections, skipped }
  if (typeof raw.exportedAt === 'string') config.exportedAt = raw.exportedAt
  if (typeof raw.client === 'string') config.client = raw.client
  return { ok: true, config }
}

// ── review: what applying a section would change ─────────────────────────────

/** One `key  from → to` line. `axis` set: the renderer names the axis (it owns the labels). */
export interface DiffRow {
  k: string
  from: string
  to: string
  axis?: number
  board?: string
}

export interface SectionDiff {
  id: SectionId
  title: string
  /** Short count for the heading: "2 changes", "3 nodes", "4 axes · board 4134-A7". */
  summary: string
  rows: DiffRow[]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const onOff = (b: boolean) => (b ? 'On' : 'Off')

const APP_FIELDS: { key: keyof AppSettings; label: string; show?: (v: never) => string }[] = [
  { key: 'sourceMode', label: 'Source mode' },
  { key: 'transport', label: 'DCS transport' },
  { key: 'host', label: 'DCS host' },
  { key: 'commandPort', label: 'Command port' },
  { key: 'listenPort', label: 'Listen port' },
  { key: 'autoConnect', label: 'Connect automatically', show: onOff },
  { key: 'replayDriveSerial', label: 'Replay drives the SimGateway', show: onOff },
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

const LIMITS: { key: keyof PsuLimits; label: string; unit: string }[] = [
  { key: 'a12', label: '12 V rail limit', unit: 'A' },
  { key: 'a5', label: '5 V rail limit', unit: 'A' },
  { key: 'w', label: 'Total power', unit: 'W' }
]

function diffPsu(cur: PsuSetting, next: PsuSetting): DiffRow[] {
  const name = (p: PsuSetting) =>
    p.mode === 'preset' ? `${PSU_PRESETS[p.preset].label} preset` : 'Custom'
  const rows: DiffRow[] = []
  if (name(cur) !== name(next)) rows.push({ k: 'PSU', from: name(cur), to: name(next) })
  // Custom limits are kept while a preset is picked, so they are compared either way.
  for (const l of LIMITS) {
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

function diffNodes(
  defaults: Map<number, NodeDefaults>,
  cur: NodeMappingFile,
  next: NodeMappingFile
): { rows: DiffRow[]; nodes: number } {
  const a = effectiveMapping(defaults, cur)
  const b = effectiveMapping(defaults, next)
  const curIgnored = new Set(cur.ignored)
  const nextIgnored = new Set(next.ignored)
  const zone = (map: Map<number, MappedNode>, pduId: number | null) =>
    pduId === null ? '—' : (map.get(pduId)?.name ?? defaults.get(pduId)?.name ?? `Node ${pduId}`)
  const where = (map: Map<number, MappedNode>, m: MappedNode) =>
    `${m.console} · ${zone(map, m.pduId)}`
  const rows: DiffRow[] = []
  const changed = new Set<number>()
  const ids = [...new Set([...a.keys(), ...b.keys(), ...cur.ignored, ...next.ignored])].sort(
    (x, y) => x - y
  )
  for (const id of ids) {
    const push = (k: string, from: string, to: string) => {
      rows.push({ k, from, to })
      changed.add(id)
    }
    const wasIgnored = curIgnored.has(id)
    const isIgnored = nextIgnored.has(id)
    if (wasIgnored !== isIgnored)
      push(`#${id}`, wasIgnored ? 'ignored' : 'not ignored', isIgnored ? 'ignored' : 'not ignored')
    const x = a.get(id)
    const y = b.get(id)
    if (!defaults.has(id)) {
      // Adopted (or not) as a whole: name, console and power zone together.
      const show = (map: Map<number, MappedNode>, m?: MappedNode) =>
        m ? `${m.name} · ${where(map, m)}` : 'not adopted'
      if (wasIgnored || isIgnored) continue // an ignored id is shown by its ignore row only
      if (show(a, x) !== show(b, y)) push(`#${id}`, show(a, x), show(b, y))
      continue
    }
    const d = defaults.get(id)!
    if (!x || !y) continue // ignored registry node: its overrides are not shown
    if (x.name !== y.name) push(`${d.name} · name`, x.name, y.name)
    if (x.console !== y.console) push(`${d.name} · console`, x.console, y.console)
    if (zone(a, x.pduId) !== zone(b, y.pduId))
      push(`${d.name} · power zone`, zone(a, x.pduId), zone(b, y.pduId))
    if (x.hidden !== y.hidden)
      push(`${d.name} · hidden`, x.hidden ? 'yes' : 'no', y.hidden ? 'yes' : 'no')
  }
  return { rows, nodes: changed.size }
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
  imported: Partial<ConfigSnapshot>
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
      const d = diffNodes(defaults, current.nodeMapping, imported.nodeMapping!)
      rows = d.rows
      summary = plural(d.nodes, 'node')
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

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * Calibration merges into the client's copy per board serial: the axes the file has replace the
 * same axes, every other cached axis and board is kept. The board's date is the newer of the two.
 */
export function mergeCalibration(cache: CalCache, imported: CalCache): CalCache {
  const boards = { ...cache.boards }
  for (const [serial, board] of Object.entries(imported.boards)) {
    const cur = boards[serial]
    const confirmedAt =
      cur && cur.confirmedAt > board.confirmedAt ? cur.confirmedAt : board.confirmedAt
    boards[serial] = { confirmedAt, axes: { ...cur?.axes, ...board.axes } }
  }
  return { ...cache, boards }
}

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

/** Every section DEFAULT_CONFIG knows, for a snapshot from defaults (tests, first run). */
export const DEFAULT_APP_SETTINGS: AppSettings = appSettings(DEFAULT_CONFIG)
