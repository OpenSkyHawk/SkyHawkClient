// Node mapping: display name, console and power zone (PDU) per NODE_ID, when each board was last
// seen, and "hidden until it reports again" flags. Pure, no Node/Electron deps — main persists it
// as <userData>/node-mapping.json (src/main/nodes/mapping-store.ts, file format mapping-file.ts).
//
// The registry (the bundled NODE_IDS) is a dictionary: a registry board joins your cockpit when you
// add it in New on the bus (pre-filled with its registry defaults). The file (v4, sparse) stores per
// board one "in your cockpit" marker (`added`), the kind the board reported, only the fields you
// changed, and when it was last seen — so a later NODE_IDS.md still reaches every field you left
// alone. Adopted nodes — NODE_IDs the registry does not know, named by the user — store name,
// console and power zone too, since there is nothing to default from (#93).

import { MAX_NODE_ID } from '@shared/firmware'
import type {
  AdoptedRow,
  AdoptSpec,
  MappedNode,
  MappingPatch,
  NodeDefaults,
  NodeIdentity,
  NodeKind,
  NodeMappingFile,
  NodeOverride,
  ResetOptions,
  ResetPreview,
  ResetRow
} from '@shared/nodes'
import { requireAdoptable } from './node-kind'
import { adopted, forgettable, inCockpit } from './membership'
import { MappingError } from './mapping-error'

export { MappingError }

/**
 * A NODE_ID's identity (node-kind.ts boardIdentity: the roster's reported kind and PDU telemetry,
 * then what is stored for a board in your cockpit). Required: every mutator that needs a board's
 * kind is handed main's, so validation sees exactly what the model shows (S7).
 */
export type KindOf = (nodeId: number) => NodeIdentity | undefined

/**
 * File format this build writes. A file with a higher version came from a newer client.
 * v4 (S1): `added` is the one "in your cockpit" marker, for adopted boards too, and `kind` is what
 * the board reported; read exactly as written. Older files (v3; v1 and early v2 dev builds without
 * the marker) are upgraded on read, and written as v4 on the next save — see sanitizeNodeMapping.
 */
export const NODE_MAPPING_VERSION = 4

export const EMPTY_MAPPING: NodeMappingFile = { version: NODE_MAPPING_VERSION, nodes: {} }

const MAX_TEXT = 64

export const isNodeId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_NODE_ID

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, MAX_TEXT)
  return t || undefined
}

/** Which file an entry comes from: how it is marked in your cockpit on the way to v4. */
type From = 'v4' | 'v3' | 'legacy'

function sanitizeOverride(raw: unknown, from: From): NodeOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const o: NodeOverride = {}
  const name = text(r.name)
  if (name) o.name = name
  const console = text(r.console)
  if (console) o.console = console
  if (r.pduId === null || isNodeId(r.pduId)) o.pduId = r.pduId
  if (r.kind === 'pdu' || r.kind === 'panel') o.kind = r.kind
  if (r.hidden === true) o.hidden = true
  if (typeof r.lastSeen === 'string' && !Number.isNaN(Date.parse(r.lastSeen))) {
    o.lastSeen = r.lastSeen
  }
  if (r.added === true) o.added = true
  // v3 and older: an adopted board was in your cockpit by being complete, not by a marker.
  else if (from !== 'v4' && adopted(o)) o.added = true
  // Before v3 a board was in your cockpit by having been seen, placed, renamed or hidden. An id the
  // registry does not know marked this way is never shown, so it is never editable either (M9:
  // membership.ts inCockpit).
  else if (from === 'legacy' && !o.kind && (o.lastSeen || o.hidden || hasOverride(o))) {
    o.added = true
  }
  return Object.keys(o).length ? o : undefined
}

/**
 * Tolerant read: anything malformed is dropped field by field, never thrown. Every older file is
 * upgraded to v4 here, once (the next save writes it):
 * - v3: an adopted board (a name and a kind of its own) gets the marker; a registry board you added
 *   already has it. Nothing else changes: a registry board's kind is stored the next time it reports.
 * - before v3 (no version counts as old): the ignore list is dropped — Ignore never shipped and is
 *   gone (#93) — and an entry seen, placed, renamed or hidden is marked, since that is how it was in
 *   your cockpit then; an adopted one is marked as in v3.
 * A v4 file (or a newer one, read-only: mapping-file.ts) is read as written: an entry without the
 * marker (say, one a config import brought) never joins your cockpit by a reload.
 */
export function sanitizeNodeMapping(raw: unknown): NodeMappingFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MAPPING, nodes: {} }
  const r = raw as Record<string, unknown>
  const nodes: Record<number, NodeOverride> = {}
  if (r.nodes && typeof r.nodes === 'object') {
    const raws = Object.entries(r.nodes as Record<string, unknown>)
    const v = typeof r.version === 'number' ? r.version : 0
    const from: From = v >= NODE_MAPPING_VERSION ? 'v4' : v === 3 ? 'v3' : 'legacy'
    for (const [k, val] of raws) {
      const id = Number(k)
      const o = isNodeId(id) ? sanitizeOverride(val, from) : undefined
      if (o) nodes[id] = o
    }
  }
  return { version: NODE_MAPPING_VERSION, nodes }
}

const hasOverride = (o: NodeOverride): boolean =>
  o.name !== undefined || o.console !== undefined || o.pduId !== undefined

/** The fields Reset gives back to a registry board, in the order its review lists them. */
const FIELDS = ['name', 'console', 'pduId'] as const
type Field = (typeof FIELDS)[number]

/**
 * A power zone of none whose NODE_IDS.md PDU is not in your cockpit (one you forgot, say): Reset
 * keeps it, so it never links a board back to a PDU you forgot, and it is no difference to undo.
 */
function keepsNone(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile,
  d: NodeDefaults,
  o: NodeOverride
): boolean {
  const p = d.pduId
  return o.pduId === null && p !== null && !inCockpit(defaults, p, file.nodes[p])
}

/**
 * A registry board's stored fields that differ from what Reset would give it — "differs", counted
 * against the registry, not from what happens to be stored (S1). A field you left alone never does.
 */
function differing(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile,
  d: NodeDefaults,
  o: NodeOverride
): Field[] {
  return FIELDS.filter(
    (k) =>
      o[k] !== undefined && o[k] !== d[k] && !(k === 'pduId' && keepsNone(defaults, file, d, o))
  )
}

/**
 * Registry defaults + overrides, plus adopted nodes. Every registry entry is listed (it is the
 * dictionary names and power zones resolve against); `known` says which are in your cockpit. A
 * board's kind is what it reported when stored, else its registry kind.
 */
export function effectiveMapping(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile
): Map<number, MappedNode> {
  const out = new Map<number, MappedNode>()
  for (const [nodeId, d] of defaults) {
    const o = file.nodes[nodeId] ?? {}
    const m: MappedNode = {
      nodeId,
      name: o.name ?? d.name,
      console: o.console ?? d.console,
      pduId: o.pduId !== undefined ? o.pduId : d.pduId,
      kind: o.kind ?? d.kind,
      source: 'registry',
      differs: differing(defaults, file, d, o).length > 0,
      hidden: o.hidden === true,
      known: inCockpit(defaults, nodeId, o)
    }
    if (o.lastSeen) m.lastSeen = o.lastSeen
    out.set(nodeId, m)
  }
  for (const [k, o] of Object.entries(file.nodes)) {
    const nodeId = Number(k)
    // The same predicate every mutator checks (M9): what is not listed here cannot be edited.
    if (defaults.has(nodeId) || !inCockpit(defaults, nodeId, o)) continue
    const m: MappedNode = {
      nodeId,
      name: o.name!,
      console: o.console ?? '',
      pduId: o.pduId ?? null,
      kind: o.kind!,
      source: 'adopted',
      differs: false,
      hidden: o.hidden === true,
      known: true
    }
    if (o.lastSeen) m.lastSeen = o.lastSeen
    out.set(nodeId, m)
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]))
}

/** How many registry nodes differ from their defaults — what "Reset all" would change. */
export function differingCount(defaults: Map<number, NodeDefaults>, file: NodeMappingFile): number {
  let n = 0
  for (const [k, o] of Object.entries(file.nodes)) {
    const d = defaults.get(Number(k))
    if (d && differing(defaults, file, d, o).length) n++
  }
  return n
}

function sameOverride(a: NodeOverride, b: NodeOverride): boolean {
  const ka = Object.keys(a) as (keyof NodeOverride)[]
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/**
 * Set (or with an empty override, remove) one node's entry. Returns the SAME object when nothing
 * changes, which is how callers skip a pointless write and push.
 */
function withNode(
  file: NodeMappingFile,
  nodeId: number,
  o: NodeOverride | undefined
): NodeMappingFile {
  const cur = file.nodes[nodeId]
  const remove = !o || !Object.keys(o).length
  if (remove ? cur === undefined : cur !== undefined && sameOverride(cur, o)) return file
  const nodes = { ...file.nodes }
  if (o && Object.keys(o).length) nodes[nodeId] = o
  else delete nodes[nodeId]
  return { ...file, nodes }
}

/**
 * These arrive over IPC from the renderer, where types are only a promise. Anything that is not a
 * plain object (null, a string, an array) is refused here as a MappingError, so the caller gets
 * `{ ok: false }` rather than a TypeError surfacing as a rejected invoke. The config import's file
 * check uses the same test (config-file.ts).
 */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A power zone names the PDU feeding a node: a PDU has none, and a panel's must be a registry or
 * adopted PDU — never itself or another panel. Checked on set only; a stored zone that later stops
 * pointing at a PDU (a registry change) still loads, since rewriting user data on read is worse
 * than one odd zone, and grouping only ever starts from a real PDU.
 */
function checkPowerZone(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  kind: NodeKind,
  pduId: number | null | undefined,
  kindOf: KindOf
): void {
  if (pduId === undefined || pduId === null) return
  if ((kindOf(nodeId) ?? kind) === 'pdu') throw new MappingError('A PDU has no power zone')
  // The zone must be a placed node that is a PDU — by what it reports, not only what was stored.
  const zone = pduId === nodeId ? undefined : effectiveMapping(defaults, file).get(pduId)
  if (!zone || (kindOf(pduId) ?? zone.kind) !== 'pdu') {
    throw new MappingError('Power zone must be a PDU')
  }
}

function checkPatch(p: MappingPatch): void {
  if (p.name !== undefined && !text(p.name)) throw new MappingError('Name cannot be empty')
  if (p.console !== undefined && !text(p.console)) throw new MappingError('Console cannot be empty')
  if (p.pduId !== undefined && p.pduId !== null && !isNodeId(p.pduId)) {
    throw new MappingError(`Not a NODE_ID: ${p.pduId}`)
  }
}

/** Apply name / console / power zone to an entry; a registry default is stored as absent. */
function patched(cur: NodeOverride | undefined, d: NodeDefaults | undefined, patch: MappingPatch) {
  const next: NodeOverride = { ...cur }
  for (const key of ['name', 'console', 'pduId'] as const) {
    if (!(key in patch)) continue
    const v = key === 'pduId' ? patch.pduId : text(patch[key])
    if (d && v === d[key]) delete next[key]
    else (next as Record<string, unknown>)[key] = v
  }
  return next
}

/**
 * Change name / console / power zone. For a registry node a value equal to its default is
 * stored as absent, so the file holds only real differences.
 */
export function setNodeMapping(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  patch: MappingPatch,
  kindOf: KindOf
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!isPlainObject(patch)) throw new MappingError('Invalid mapping change')
  checkPatch(patch)
  const d = defaults.get(nodeId)
  const cur = file.nodes[nodeId]
  if (!inCockpit(defaults, nodeId, cur)) {
    throw new MappingError(`Node ${nodeId} is not in your cockpit — add it first`)
  }
  if ('pduId' in patch) {
    // Its kind as stored (what it reported), else the registry's.
    checkPowerZone(file, defaults, nodeId, cur!.kind ?? d!.kind, patch.pduId, kindOf)
  }
  return withNode(file, nodeId, patched(cur, d, patch))
}

/**
 * Add a board to your cockpit (New on the bus). A registry board keeps its NODE_IDS.md defaults
 * where the form left them and stores only what differs; a NODE_ID the registry does not know is
 * adopted and stored in full. Either way it gets the marker and the kind it reported, and stops
 * being "new" from here on.
 */
export function adoptNode(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  spec: AdoptSpec,
  kindOf: KindOf
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!isPlainObject(spec)) throw new MappingError('Invalid adopt request')
  const d = defaults.get(nodeId)
  if (d) return addRegistryBoard(file, defaults, nodeId, d, spec, kindOf)
  // Name and console are required here, not just validated when present: an entry without a
  // name is not an adopted node (effectiveMapping skips it), so it would stay "new" after an ok.
  const name = text(spec.name)
  if (!name) throw new MappingError('Name cannot be empty')
  const console = text(spec.console)
  if (!console) throw new MappingError('Console cannot be empty')
  checkPatch(spec)
  if (spec.kind !== 'pdu' && spec.kind !== 'panel') throw new MappingError('Unknown node kind')
  // Adopt only what a board has said it is, and as what it said (#344): never a guess.
  requireAdoptable(kindOf(nodeId), spec.kind)
  // A PDU's zone is forced to none below (the adopt form has a group label, not powered-by).
  if (spec.kind === 'panel') checkPowerZone(file, defaults, nodeId, 'panel', spec.pduId, kindOf)
  const o: NodeOverride = {
    added: true,
    name,
    console,
    pduId: spec.kind === 'pdu' ? null : (spec.pduId ?? null),
    kind: spec.kind
  }
  return withNode(file, nodeId, o)
}

/** A registry board into your cockpit: the form's values, stored as differences from its defaults. */
function addRegistryBoard(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  d: NodeDefaults,
  spec: AdoptSpec,
  kindOf: KindOf
): NodeMappingFile {
  const name = text(spec.name)
  if (!name) throw new MappingError('Name cannot be empty')
  const console = text(spec.console)
  if (!console) throw new MappingError('Console cannot be empty')
  checkPatch(spec)
  // Added only once the board has said what it is — a PDU or a panel group — like any new board
  // (#344): a registry entry is never taken as its kind. What it said is stored (S1 bug 3).
  const kind = requireAdoptable(kindOf(nodeId))
  const patch: MappingPatch = { name, console }
  if (kind !== 'pdu') {
    checkPowerZone(file, defaults, nodeId, kind, spec.pduId, kindOf)
    patch.pduId = spec.pduId ?? null
  }
  return withNode(file, nodeId, { ...patched(file.nodes[nodeId], d, patch), added: true, kind })
}

/**
 * Remove a board from your cockpit, keeping nothing (#93): its name, placement, hidden flag and
 * last-seen time all go. If it reports again it starts fresh in New on the bus — a registry board
 * pre-filled from NODE_IDS.md, an unregistered one blank. Forgetting a PDU also unlinks the boards in
 * your cockpit it fed: they show under their console's No power zone, and the links are not
 * restored if it comes back. main refuses this while the board is online.
 */
export function forgetNode(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  kindOf: KindOf
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  const mapped = effectiveMapping(defaults, file)
  let next = withNode(file, nodeId, undefined)
  // A PDU by what it reports now, else by the kind stored for it in your cockpit (KindOf).
  if (kindOf(nodeId) === 'pdu') {
    for (const m of mapped.values()) {
      if (m.nodeId === nodeId || !m.known || m.pduId !== nodeId) continue
      const d = defaults.get(m.nodeId)
      // Registry default pointing at the forgotten PDU: stored as an explicit "none".
      const o = patched(next.nodes[m.nodeId], d, { pduId: null })
      if (d && d.pduId === nodeId) o.pduId = null
      next = withNode(next, m.nodeId, o)
    }
  }
  return next
}

/**
 * One registry board back to its NODE_IDS.md name, console and power zone. It stays in your
 * cockpit: being added, hidden and last seen are not overrides.
 */
export function resetNode(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  const d = defaults.get(nodeId)
  if (!d) throw new MappingError('Only a registry board has defaults')
  return withNode(file, nodeId, keptOnReset(defaults, file, d, file.nodes[nodeId]))
}

/**
 * What a reset leaves of a registry board's entry: everything that is not an override (the marker
 * — an adopted one stays in your cockpit, as a registry one — its reported kind, hidden and last
 * seen), and a power zone of none that `keepsNone`: Reset never links a board to a PDU you forgot.
 */
function keptOnReset(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile,
  d: NodeDefaults,
  o: NodeOverride | undefined
): NodeOverride {
  const kept: NodeOverride = {}
  if (o?.added) kept.added = true
  if (o?.kind) kept.kind = o.kind
  if (o?.hidden) kept.hidden = true
  if (o?.lastSeen) kept.lastSeen = o.lastSeen
  if (o && keepsNone(defaults, file, d, o)) kept.pduId = null
  return kept
}

/**
 * Every registry node back to its defaults. Adopted nodes, being added, hidden flags and last-seen
 * times are not registry overrides, so they stay — unless `forgetAdopted`, which also drops the adopted nodes
 * `resetPreview` lists (see `forgettable`).
 */
export function resetMapping(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  opts: ResetOptions = {}
): NodeMappingFile {
  if (
    !isPlainObject(opts) ||
    (opts.forgetAdopted !== undefined && typeof opts.forgetAdopted !== 'boolean')
  ) {
    throw new MappingError('Invalid reset request')
  }
  const drop = new Set(opts.forgetAdopted === true ? forgettable(defaults, file) : [])
  if (differingCount(defaults, file) === 0 && drop.size === 0) return file // no write
  const nodes: Record<number, NodeOverride> = {}
  for (const [k, o] of Object.entries(file.nodes)) {
    const id = Number(k)
    const d = defaults.get(id)
    if (!d) {
      if (!drop.has(id)) nodes[id] = o
      continue
    }
    const kept = keptOnReset(defaults, file, d, o)
    if (Object.keys(kept).length) nodes[id] = kept
  }
  return { ...file, nodes }
}

/** What `resetMapping` would change, field by field. Counted like `differingCount`. */
export function resetPreview(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile
): ResetPreview {
  const mapped = effectiveMapping(defaults, file)
  const zoneName = (pduId: number | null | undefined): string =>
    pduId == null ? '—' : (mapped.get(pduId)?.name ?? defaults.get(pduId)?.name ?? `Node ${pduId}`)
  const rows: ResetRow[] = []
  let nodeCount = 0
  const adoptedRows: AdoptedRow[] = forgettable(defaults, file).map((id) => {
    const m = mapped.get(id)!
    return { nodeId: id, name: m.name, console: m.console, zone: zoneName(m.pduId) }
  })
  const ids = Object.keys(file.nodes)
    .map(Number)
    .filter((id) => defaults.has(id))
    .sort((a, b) => a - b)
  for (const id of ids) {
    const o = file.nodes[id]!
    const d = defaults.get(id)!
    const fields = differing(defaults, file, d, o)
    if (!fields.length) continue
    nodeCount++
    for (const field of fields) {
      if (field === 'pduId') {
        const zone = { from: zoneName(o.pduId), to: zoneName(d.pduId) }
        rows.push({ nodeId: id, node: d.name, field: 'power zone', ...zone })
      } else rows.push({ nodeId: id, node: d.name, field, from: o[field]!, to: d[field] })
    }
  }
  return { rows, nodeCount, adopted: adoptedRows }
}

/**
 * A config import's node mapping section, read strictly (C1). A local file is read tolerantly
 * (sanitizeNodeMapping: whatever is malformed is dropped), but an import replaces your cockpit as
 * written, so a section that lost its structure must never read as an intentionally empty mapping.
 * Its markers are the two fields every node-mapping.json has: `version` (an integer this client
 * reads: 1 to NODE_MAPPING_VERSION) and `nodes` (an object of entries). With both, the entries go
 * through the same tolerant sanitizer a local file does, so a v1–v3 section is upgraded to v4 the
 * way the file is. `reason` completes "Node mapping: …".
 */
export function checkImportedMapping(
  raw: unknown
): { ok: true; value: NodeMappingFile } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'it is not a settings section' }
  const v = raw.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, reason: 'it has no version' }
  }
  if (v > NODE_MAPPING_VERSION) return { ok: false, reason: 'it was written by a newer client' }
  if (!isPlainObject(raw.nodes)) return { ok: false, reason: 'it has no list of boards' }
  return { ok: true, value: sanitizeNodeMapping(raw) }
}

/**
 * A config import (D3): the mapping comes in as written — names, consoles, power zones, hidden
 * flags, kinds and membership, both the registry boards you added and the boards you adopted — so
 * a board the file has in its cockpit joins yours, and one it does not have leaves. Only what this
 * computer observed stays, for a board that is in your cockpit after the import: each board's
 * `lastSeen`, and the kind it reported here where the file has none. Hidden is stored only on a
 * board in your cockpit (S4), and never on one on the bus: Hide is for offline boards only.
 */
export function importMapping(
  current: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  imported: NodeMappingFile,
  /** Boards on the bus now: an import never hides one — Hide is for offline boards only. */
  online: Iterable<number> = []
): NodeMappingFile {
  const onBus = new Set(online)
  const nodes: Record<number, NodeOverride> = {}
  const ids = new Set([...Object.keys(current.nodes), ...Object.keys(imported.nodes)].map(Number))
  for (const id of [...ids].sort((a, b) => a - b)) {
    const { lastSeen: _seen, ...set } = imported.nodes[id] ?? {}
    const o: NodeOverride = { ...set }
    const member = inCockpit(defaults, id, o)
    if (onBus.has(id) || !member) delete o.hidden
    const here = current.nodes[id]
    if (member && here?.lastSeen) o.lastSeen = here.lastSeen
    if (member && o.kind === undefined && here?.kind) o.kind = here.kind
    if (Object.keys(o).length) nodes[id] = o
  }
  return { version: NODE_MAPPING_VERSION, nodes }
}

/** An on/off from the renderer must be a real boolean: 'no' or 'false' is truthy. */
function checkOnOff(on: unknown): void {
  if (typeof on !== 'boolean') throw new MappingError('Invalid on/off value')
}

function withoutHidden(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  const next: NodeOverride = { ...file.nodes[nodeId] }
  delete next.hidden
  return withNode(file, nodeId, next)
}

/**
 * Set or clear "hidden until it reports again" — for a replaced / removed board, so only a
 * registry or adopted node can be hidden (main also refuses it while the board is online: a board
 * on the bus is active, so it always shows). Clearing is allowed for any id, so a stray flag can
 * always be removed.
 */
export function setHidden(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  on: boolean
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  checkOnOff(on)
  if (!on) return withoutHidden(file, nodeId)
  const cur = file.nodes[nodeId]
  if (!inCockpit(defaults, nodeId, cur)) {
    throw new MappingError('Only a board in your cockpit can be hidden')
  }
  return withNode(file, nodeId, { ...file.nodes[nodeId], hidden: true })
}

/**
 * Clear the hidden flag of every node that is reporting again. Returns the same object when
 * nothing changed, so the caller can skip the write.
 */
export function clearReportedHidden(
  file: NodeMappingFile,
  presentIds: Iterable<number>
): NodeMappingFile {
  let next = file
  for (const id of presentIds) {
    if (next.nodes[id]?.hidden) next = withoutHidden(next, id)
  }
  return next
}

/**
 * Record that these boards were on the bus at `at` (ISO 8601) — only boards in your cockpit
 * (added or adopted). One still waiting in New on the bus is not, until it is added.
 */
export function markSeen(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  ids: Iterable<number>,
  at: string
): NodeMappingFile {
  let next = file
  for (const id of ids) {
    const cur = next.nodes[id]
    if (!inCockpit(defaults, id, cur)) continue
    next = withNode(next, id, { ...cur, lastSeen: at })
  }
  return next
}

/**
 * Store the kind each board reported (its NODE_KIND, or PDU pages) — only on boards in your
 * cockpit — so one that is offline still reads as what it said it is (S1 bug 3), and Forget of a PDU
 * that has not reported this session still unlinks its boards. Returns the same object when nothing
 * changed, so the caller can skip the write.
 */
export function recordKinds(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  reported: Iterable<readonly [nodeId: number, kind: NodeKind]>
): NodeMappingFile {
  let next = file
  for (const [id, kind] of reported) {
    const cur = next.nodes[id]
    if (!inCockpit(defaults, id, cur) || cur!.kind === kind) continue
    next = withNode(next, id, { ...cur, kind })
  }
  return next
}
