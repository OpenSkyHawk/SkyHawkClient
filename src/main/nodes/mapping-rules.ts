// Node mapping: display name, console and power zone (PDU) per NODE_ID, when each board was last
// seen, and "hidden until it reports again" flags. Pure, no Node/Electron deps — main persists it
// as <userData>/node-mapping.json (src/main/nodes/mapping-store.ts, file format mapping-file.ts).
//
// The registry (the bundled NODE_IDS) is a dictionary: a registry board joins your cockpit when you
// add it in New on the bus (pre-filled with its registry defaults), and the file stores that it was
// added, only what differs, and when it was last seen. Adopted nodes — NODE_IDs the registry does
// not know, named by the user — are stored in full, since there is nothing to default from (#93).

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
import { isAdoptableKind } from './node-kind'
import { adopted, forgettable, inCockpit } from './membership'

/**
 * A NODE_ID's type from live signals (node-kind.ts resolveKind over the roster's reported kind and
 * PDU telemetry, then what is stored). main passes it so validation sees what the model shows;
 * without it (tests, older callers) only stored kinds count.
 */
export type KindOf = (nodeId: number) => NodeIdentity | undefined

/**
 * File format this build writes. A file with a higher version came from a newer client.
 * v3 (#93): `added` and `lastSeen` per node, read exactly as written; no ignore list. Older files
 * (v1, and early v2 dev builds without the marker) are upgraded on read — see sanitizeNodeMapping.
 */
export const NODE_MAPPING_VERSION = 3

export const EMPTY_MAPPING: NodeMappingFile = { version: 3, nodes: {} }

const MAX_TEXT = 64

export const isNodeId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_NODE_ID

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, MAX_TEXT)
  return t || undefined
}

function sanitizeOverride(raw: unknown, legacy: boolean): NodeOverride | undefined {
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
  // Before v3 a board was in your cockpit by having been seen, placed, renamed or hidden.
  else if (legacy && !o.kind && (o.lastSeen || o.hidden || hasOverride(o))) o.added = true
  return Object.keys(o).length ? o : undefined
}

/**
 * Tolerant read: anything malformed is dropped field by field, never thrown. Upgrading a file from
 * before v3 (no version counts as old): its ignore list is dropped — Ignore never shipped and is
 * gone (#93) — and a registry entry seen, placed, renamed or hidden is marked added, since that is
 * how it was in your cockpit then. A v3 file is read as written: an entry without `added` (say,
 * one a config import brought) never becomes added by a reload.
 */
export function sanitizeNodeMapping(raw: unknown): NodeMappingFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MAPPING, nodes: {} }
  const r = raw as Record<string, unknown>
  const nodes: Record<number, NodeOverride> = {}
  if (r.nodes && typeof r.nodes === 'object') {
    const raws = Object.entries(r.nodes as Record<string, unknown>)
    const legacy = typeof r.version !== 'number' || r.version < NODE_MAPPING_VERSION
    for (const [k, v] of raws) {
      const id = Number(k)
      const o = isNodeId(id) ? sanitizeOverride(v, legacy) : undefined
      if (o) nodes[id] = o
    }
  }
  return { version: 3, nodes }
}

const hasOverride = (o: NodeOverride): boolean =>
  o.name !== undefined || o.console !== undefined || o.pduId !== undefined

/**
 * Registry defaults + overrides, plus adopted nodes. Every registry entry is listed (it is the
 * dictionary names and power zones resolve against); `known` says which are in your cockpit.
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
      kind: d.kind,
      source: 'registry',
      differs: hasOverride(o),
      hidden: o.hidden === true,
      known: inCockpit(o)
    }
    if (o.lastSeen) m.lastSeen = o.lastSeen
    out.set(nodeId, m)
  }
  for (const [k, o] of Object.entries(file.nodes)) {
    const nodeId = Number(k)
    if (defaults.has(nodeId) || !adopted(o)) continue
    const m: MappedNode = {
      nodeId,
      name: o.name,
      console: o.console ?? '',
      pduId: o.pduId ?? null,
      kind: o.kind,
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
    if (defaults.has(Number(k)) && hasOverride(o)) n++
  }
  return n
}

/** Thrown for input the UI should have prevented; main turns it into an error result. */
export class MappingError extends Error {}

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
  kindOf?: KindOf
): void {
  if (pduId === undefined || pduId === null) return
  if ((kindOf?.(nodeId) ?? kind) === 'pdu') throw new MappingError('A PDU has no power zone')
  // The zone must be a placed node that is a PDU — by what it reports, not only what was stored.
  const zone = pduId === nodeId ? undefined : effectiveMapping(defaults, file).get(pduId)
  if (!zone || (kindOf?.(pduId) ?? zone.kind) !== 'pdu') {
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
  kindOf?: KindOf
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!isPlainObject(patch)) throw new MappingError('Invalid mapping change')
  checkPatch(patch)
  const d = defaults.get(nodeId)
  const cur = file.nodes[nodeId]
  if (!inCockpit(cur)) {
    throw new MappingError(`Node ${nodeId} is not in your cockpit — add it first`)
  }
  if ('pduId' in patch) {
    checkPowerZone(file, defaults, nodeId, d ? d.kind : cur!.kind!, patch.pduId, kindOf)
  }
  return withNode(file, nodeId, patched(cur, d, patch))
}

/**
 * Add a board to your cockpit (New on the bus). A registry board keeps its NODE_IDS.md defaults
 * where the form left them and stores only what differs; a NODE_ID the registry does not know is
 * adopted and stored in full. Either way it stops being "new" from here on.
 */
export function adoptNode(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  spec: AdoptSpec,
  kindOf?: KindOf
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
  if (kindOf) {
    // Adopt only what a board has said it is (#344): a PDU or a panel group, never a guess.
    const k = kindOf(nodeId)
    if (k === undefined) throw new MappingError('Its board type is not known yet')
    if (!isAdoptableKind(k)) throw new MappingError('This board cannot be adopted')
    if (k !== spec.kind)
      throw new MappingError(`It reports as a ${k === 'pdu' ? 'PDU' : 'panel group'}`)
  }
  // A PDU's zone is forced to none below (the adopt form has a group label, not powered-by).
  if (spec.kind === 'panel') checkPowerZone(file, defaults, nodeId, 'panel', spec.pduId, kindOf)
  const o: NodeOverride = {
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
  kindOf?: KindOf
): NodeMappingFile {
  const name = text(spec.name)
  if (!name) throw new MappingError('Name cannot be empty')
  const console = text(spec.console)
  if (!console) throw new MappingError('Console cannot be empty')
  checkPatch(spec)
  // Added only once the board has said what it is — a PDU or a panel group — like any new board
  // (#344): a registry entry is never taken as its kind.
  let kind = d.kind
  if (kindOf) {
    const k = kindOf(nodeId)
    if (k === undefined) throw new MappingError('Its board type is not known yet')
    if (!isAdoptableKind(k)) throw new MappingError('This board cannot be adopted')
    kind = k
  }
  const patch: MappingPatch = { name, console }
  if (kind !== 'pdu') {
    checkPowerZone(file, defaults, nodeId, d.kind, spec.pduId, kindOf)
    patch.pduId = spec.pduId ?? null
  }
  return withNode(file, nodeId, { ...patched(file.nodes[nodeId], d, patch), added: true })
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
  kindOf?: KindOf
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  const mapped = effectiveMapping(defaults, file)
  const self = mapped.get(nodeId)
  let next = withNode(file, nodeId, undefined)
  if ((kindOf?.(nodeId) ?? self?.kind) === 'pdu') {
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
  if (!defaults.has(nodeId)) throw new MappingError('Only a registry board has defaults')
  return withNode(file, nodeId, keptOnReset(file.nodes[nodeId]))
}

/** What a reset keeps of a registry board's entry: everything that is not an override. */
function keptOnReset(o: NodeOverride | undefined): NodeOverride {
  const kept: NodeOverride = {}
  if (inCockpit(o)) kept.added = true // an adopted one stays in your cockpit, as a registry one
  if (o?.hidden) kept.hidden = true
  if (o?.lastSeen) kept.lastSeen = o.lastSeen
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
    if (!defaults.has(id)) {
      if (!drop.has(id)) nodes[id] = o
      continue
    }
    const kept = keptOnReset(o)
    if (Object.keys(kept).length) nodes[id] = kept
  }
  return { ...file, nodes }
}

/** What `resetMapping` would change, field by field. Counted from the file like `differingCount`. */
export function resetPreview(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile
): ResetPreview {
  const mapped = effectiveMapping(defaults, file)
  const zoneName = (pduId: number | null | undefined): string =>
    pduId == null ? '—' : (mapped.get(pduId)?.name ?? defaults.get(pduId)?.name ?? `Node ${pduId}`)
  const rows: ResetRow[] = []
  let nodeCount = 0
  const adopted: AdoptedRow[] = forgettable(defaults, file).map((id) => {
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
    if (!hasOverride(o)) continue
    nodeCount++
    if (o.name !== undefined)
      rows.push({ nodeId: id, node: d.name, field: 'name', from: o.name, to: d.name })
    if (o.console !== undefined) {
      rows.push({ nodeId: id, node: d.name, field: 'console', from: o.console, to: d.console })
    }
    if (o.pduId !== undefined) {
      rows.push({
        nodeId: id,
        node: d.name,
        field: 'power zone',
        from: zoneName(o.pduId),
        to: zoneName(d.pduId)
      })
    }
  }
  return { rows, nodeCount, adopted }
}

/**
 * A config import's node mapping section, read strictly (C1). A local file is read tolerantly
 * (sanitizeNodeMapping: whatever is malformed is dropped), but an import replaces your cockpit as
 * written, so a section that lost its structure must never read as an intentionally empty mapping.
 * Its markers are the two fields every node-mapping.json has: `version` (an integer this client
 * reads: 1 to NODE_MAPPING_VERSION) and `nodes` (an object of entries). With both, the entries go
 * through the same tolerant sanitizer a local file does. `reason` completes "Node mapping: …".
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
 * flags and membership, both the registry boards you added and the boards you adopted — so a board
 * the file has in its cockpit joins yours, and one it does not have leaves. Only what this
 * computer observed stays: each board's `lastSeen`, kept for a board that is in your cockpit
 * after the import. Hidden is stored only on a board in your cockpit (S4), and never on one on the
 * bus: Hide is for offline boards only.
 */
export function importMapping(
  current: NodeMappingFile,
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
    const member = inCockpit(o)
    if (onBus.has(id) || !member) delete o.hidden
    const seen = current.nodes[id]?.lastSeen
    if (member && seen) o.lastSeen = seen
    if (Object.keys(o).length) nodes[id] = o
  }
  return { version: 3, nodes }
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
  _defaults: Map<number, NodeDefaults>, // kept for the mutators' common shape
  nodeId: number,
  on: boolean
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  checkOnOff(on)
  if (!on) return withoutHidden(file, nodeId)
  const cur = file.nodes[nodeId]
  if (!inCockpit(cur)) {
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
  _defaults: Map<number, NodeDefaults>, // kept for the mutators' common shape
  ids: Iterable<number>,
  at: string
): NodeMappingFile {
  let next = file
  for (const id of ids) {
    const cur = next.nodes[id]
    if (!inCockpit(cur)) continue
    next = withNode(next, id, { ...cur, lastSeen: at })
  }
  return next
}
