// Node mapping: display name, console and power zone (PDU) per NODE_ID, plus the ignore list and
// "hidden until it reports again" flags. Pure, no Node/Electron deps — main persists it as
// <userData>/node-mapping.json (src/main/node-mapping.ts).
//
// Registry nodes (the bundled NODE_IDS) take their defaults from the registry and store only what
// differs. Adopted nodes — NODE_IDs the registry does not know, named by the user — are stored in
// full, since there is nothing to default from.

export type NodeKind = 'pdu' | 'panel'

/** What node-mapping.json holds for one NODE_ID. Every field optional: absent = default. */
export interface NodeOverride {
  name?: string
  console?: string
  /** Power zone: the PDU NODE_ID feeding this node. null = explicitly none. */
  pduId?: number | null
  /** Adopted nodes only — registry nodes take their kind from the registry. */
  kind?: NodeKind
  /** Replaced / removed board: skip it until it reports again. */
  hidden?: boolean
}

/** What was known about a NODE_ID when it was ignored, for Settings › Ignored nodes. */
export interface IgnoredInfo {
  /** When it was ignored, ISO 8601. */
  at: string
  /** What it reported as at the time (a PDU sends `_NODE_TELEM`); absent if unknown. */
  kind?: NodeKind
}

export interface NodeMappingFile {
  version: 1
  nodes: Record<number, NodeOverride>
  /** NODE_IDs the user ignored permanently (never "new"). */
  ignored: number[]
  /** Per ignored NODE_ID; absent for ids ignored before this was recorded. */
  ignoredMeta?: Record<number, IgnoredInfo>
}

/** Effective defaults for one registry node. */
export interface NodeDefaults {
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
}

/** A node as the client should present it: registry defaults with overrides applied. */
export interface MappedNode {
  nodeId: number
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
  source: 'registry' | 'adopted'
  /** Registry node with at least one stored override (what reset would undo). */
  differs: boolean
  hidden: boolean
}

/** File format this build writes. A file with a higher version came from a newer client. */
export const NODE_MAPPING_VERSION = 1

export const EMPTY_MAPPING: NodeMappingFile = { version: 1, nodes: {}, ignored: [] }

const MAX_TEXT = 64

const isNodeId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 63

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, MAX_TEXT)
  return t || undefined
}

/** PDUs are named `PDU_<console>` in NODE_IDS.md, which has no type column. */
export const isPduName = (name: string): boolean => /^PDU_/.test(name)

/**
 * Registry defaults, keyed by NODE_ID. NODE_ID 0 (PanelBridge) never appears on the bus and is
 * left out. A panel's default power zone is the PDU on its console when there is exactly one;
 * with none or several there is no safe guess, so it is left unmapped.
 */
export function registryDefaults(
  registry: Record<number, { name: string; console: string }>
): Map<number, NodeDefaults> {
  const ids = Object.keys(registry)
    .map(Number)
    .filter(isNodeId)
    .sort((a, b) => a - b)
  const pdusOn = (console: string) =>
    ids.filter((id) => isPduName(registry[id]!.name) && registry[id]!.console === console)
  const out = new Map<number, NodeDefaults>()
  for (const id of ids) {
    const { name, console } = registry[id]!
    const kind: NodeKind = isPduName(name) ? 'pdu' : 'panel'
    const pdus = kind === 'panel' ? pdusOn(console) : []
    out.set(id, { name, console, kind, pduId: pdus.length === 1 ? pdus[0]! : null })
  }
  return out
}

function sanitizeOverride(raw: unknown): NodeOverride | undefined {
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
  return Object.keys(o).length ? o : undefined
}

function sanitizeIgnoredInfo(raw: unknown): IgnoredInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return undefined
  const info: IgnoredInfo = { at: r.at }
  if (r.kind === 'pdu' || r.kind === 'panel') info.kind = r.kind
  return info
}

/** Tolerant read: anything malformed is dropped field by field, never thrown. */
export function sanitizeNodeMapping(raw: unknown): NodeMappingFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MAPPING, nodes: {}, ignored: [] }
  const r = raw as Record<string, unknown>
  const nodes: Record<number, NodeOverride> = {}
  if (r.nodes && typeof r.nodes === 'object') {
    for (const [k, v] of Object.entries(r.nodes as Record<string, unknown>)) {
      const id = Number(k)
      const o = isNodeId(id) ? sanitizeOverride(v) : undefined
      if (o) nodes[id] = o
    }
  }
  const ignored = Array.isArray(r.ignored)
    ? [...new Set(r.ignored.filter(isNodeId))].sort((a, b) => a - b)
    : []
  const file: NodeMappingFile = { version: 1, nodes, ignored }
  // Kept only for ids still on the ignore list, so a stray entry cannot outlive its ignore.
  const meta: Record<number, IgnoredInfo> = {}
  const rawMeta = (
    r.ignoredMeta && typeof r.ignoredMeta === 'object' ? r.ignoredMeta : {}
  ) as Record<string, unknown>
  for (const id of ignored) {
    const info = sanitizeIgnoredInfo(rawMeta[id])
    if (info) meta[id] = info
  }
  if (Object.keys(meta).length) file.ignoredMeta = meta
  return file
}

/** An adopted node is a non-registry entry complete enough to place: name, console and kind. */
function adopted(
  o: NodeOverride | undefined
): o is NodeOverride & { name: string; kind: NodeKind } {
  return !!o?.name && !!o.kind
}

/** Registry defaults + overrides, plus adopted nodes. Ignored ids are left out. */
export function effectiveMapping(
  defaults: Map<number, NodeDefaults>,
  file: NodeMappingFile
): Map<number, MappedNode> {
  const ignored = new Set(file.ignored)
  const out = new Map<number, MappedNode>()
  for (const [nodeId, d] of defaults) {
    if (ignored.has(nodeId)) continue
    const o = file.nodes[nodeId] ?? {}
    out.set(nodeId, {
      nodeId,
      name: o.name ?? d.name,
      console: o.console ?? d.console,
      pduId: o.pduId !== undefined ? o.pduId : d.pduId,
      kind: d.kind,
      source: 'registry',
      differs: o.name !== undefined || o.console !== undefined || o.pduId !== undefined,
      hidden: o.hidden === true
    })
  }
  for (const [k, o] of Object.entries(file.nodes)) {
    const nodeId = Number(k)
    if (defaults.has(nodeId) || ignored.has(nodeId) || !adopted(o)) continue
    out.set(nodeId, {
      nodeId,
      name: o.name,
      console: o.console ?? '',
      pduId: o.pduId ?? null,
      kind: o.kind,
      source: 'adopted',
      differs: false,
      hidden: o.hidden === true
    })
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]))
}

/** How many registry nodes differ from their defaults — what "Reset all" would change. */
export function differingCount(defaults: Map<number, NodeDefaults>, file: NodeMappingFile): number {
  // Counted from the file, not effectiveMapping: an ignored registry node is left out of the
  // effective mapping, but Reset still clears its overrides — and this must match what Reset does.
  let n = 0
  for (const [k, o] of Object.entries(file.nodes)) {
    if (defaults.has(Number(k)) && hasOverride(o)) n++
  }
  return n
}

const hasOverride = (o: NodeOverride): boolean =>
  o.name !== undefined || o.console !== undefined || o.pduId !== undefined

export type MappingPatch = Partial<Pick<NodeOverride, 'name' | 'console' | 'pduId'>>
export interface AdoptSpec {
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
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
 * `{ ok: false }` rather than a TypeError surfacing as a rejected invoke.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A power zone names the PDU feeding a node: a PDU has none, and a panel's must be a registry or
 * adopted PDU that is not ignored — never itself or another panel. Checked on set only; a stored
 * zone that later stops pointing at a PDU (a registry change) still loads, since rewriting user
 * data on read is worse than one odd zone, and grouping only ever starts from a real PDU.
 */
function checkPowerZone(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  kind: NodeKind,
  pduId: number | null | undefined
): void {
  if (pduId === undefined || pduId === null) return
  if (kind === 'pdu') throw new MappingError('A PDU has no power zone')
  if (pduId === nodeId || effectiveMapping(defaults, file).get(pduId)?.kind !== 'pdu') {
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

/**
 * Change name / console / power zone. For a registry node a value equal to its default is
 * stored as absent, so the file holds only real differences.
 */
export function setNodeMapping(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  patch: MappingPatch
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!isPlainObject(patch)) throw new MappingError('Invalid mapping change')
  checkPatch(patch)
  const d = defaults.get(nodeId)
  const cur = file.nodes[nodeId]
  if (!d && !adopted(cur)) throw new MappingError(`Node ${nodeId} is not mapped — adopt it first`)
  if ('pduId' in patch) checkPowerZone(file, defaults, nodeId, d ? d.kind : cur!.kind!, patch.pduId)
  const next: NodeOverride = { ...cur }
  for (const key of ['name', 'console', 'pduId'] as const) {
    if (!(key in patch)) continue
    const v = key === 'pduId' ? patch.pduId : text(patch[key])
    if (d && v === d[key]) delete next[key]
    else (next as Record<string, unknown>)[key] = v
  }
  return withNode(file, nodeId, next)
}

/** Place a NODE_ID the registry does not know. It stops being "new" from here on. */
export function adoptNode(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  spec: AdoptSpec
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!isPlainObject(spec)) throw new MappingError('Invalid adopt request')
  if (defaults.has(nodeId)) throw new MappingError(`Node ${nodeId} is in the registry`)
  // Name and console are required here, not just validated when present: an entry without a
  // name is not an adopted node (effectiveMapping skips it), so it would stay "new" after an ok.
  const name = text(spec.name)
  if (!name) throw new MappingError('Name cannot be empty')
  const console = text(spec.console)
  if (!console) throw new MappingError('Console cannot be empty')
  checkPatch(spec)
  if (spec.kind !== 'pdu' && spec.kind !== 'panel') throw new MappingError('Unknown node kind')
  // A PDU's zone is forced to none below (the adopt form has a group label, not powered-by).
  if (spec.kind === 'panel') checkPowerZone(file, defaults, nodeId, 'panel', spec.pduId)
  const o: NodeOverride = {
    name,
    console,
    pduId: spec.kind === 'pdu' ? null : (spec.pduId ?? null),
    kind: spec.kind
  }
  return withNode(unignore(file, nodeId), nodeId, o)
}

/** Drop an adopted node (it is "new" again if it reports), or a registry node's overrides. */
export function forgetNode(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  return withNode(file, nodeId, undefined)
}

export interface ResetOptions {
  /** Also drop every adopted node: each is "new" again the next time it reports. */
  forgetAdopted?: boolean
}

/**
 * The NODE_IDs "Also forget adopted nodes" drops: adopted and not ignored — exactly the ones the
 * review lists. An ignored adopted node keeps its entry (the ignore list is untouched by a reset),
 * and a stray flag on an unknown id is not an adopted node, so neither is dropped unseen.
 */
function forgettable(defaults: Map<number, NodeDefaults>, file: NodeMappingFile): number[] {
  const ignored = new Set(file.ignored)
  return Object.keys(file.nodes)
    .map(Number)
    .filter((id) => !defaults.has(id) && !ignored.has(id) && adopted(file.nodes[id]))
    .sort((a, b) => a - b)
}

/**
 * Every registry node back to its defaults. Adopted nodes, the ignore list and hidden flags are
 * not registry overrides, so they stay — unless `forgetAdopted`, which also drops the adopted nodes
 * `resetPreview` lists (see `forgettable`). The ignore list always stays.
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
    } else if (o.hidden) nodes[id] = { hidden: true }
  }
  return { ...file, nodes }
}

/** One field a reset would change, ready to show as `node · field  from → to`. */
export interface ResetRow {
  nodeId: number
  /** The node's registry name (what it is called after the reset). */
  node: string
  field: 'name' | 'console' | 'power zone'
  from: string
  to: string
}

/** An adopted node "Also forget adopted nodes" would drop. */
export interface AdoptedRow {
  nodeId: number
  name: string
  console: string
  /** Power zone as shown: the PDU's effective name, or '—'. */
  zone: string
}

export interface ResetPreview {
  rows: ResetRow[]
  /** Registry nodes the reset changes; equals `differingCount`. */
  nodeCount: number
  adopted: AdoptedRow[]
}

/**
 * What `resetMapping` would change, field by field. Counted from the file like `differingCount`,
 * so an ignored registry node with overrides is listed too — Reset clears it as well.
 */
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

function unignore(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  if (!file.ignored.includes(nodeId)) return file
  const next: NodeMappingFile = { ...file, ignored: file.ignored.filter((id) => id !== nodeId) }
  if (file.ignoredMeta?.[nodeId]) {
    const meta = { ...file.ignoredMeta }
    delete meta[nodeId]
    if (Object.keys(meta).length) next.ignoredMeta = meta
    else delete next.ignoredMeta
  }
  return next
}

/** An on/off from the renderer must be a real boolean: 'no' or 'false' is truthy. */
function checkOnOff(on: unknown): void {
  if (typeof on !== 'boolean') throw new MappingError('Invalid on/off value')
}

/** Ignore permanently, or un-ignore. `info` is recorded with a new ignore (main supplies it). */
export function setIgnored(
  file: NodeMappingFile,
  nodeId: number,
  on: boolean,
  info?: IgnoredInfo
): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  checkOnOff(on)
  if (!on) return unignore(file, nodeId)
  if (file.ignored.includes(nodeId)) return file
  const next: NodeMappingFile = {
    ...file,
    ignored: [...file.ignored, nodeId].sort((a, b) => a - b)
  }
  if (info) next.ignoredMeta = { ...file.ignoredMeta, [nodeId]: info }
  return next
}

function withoutHidden(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  const next: NodeOverride = { ...file.nodes[nodeId] }
  delete next.hidden
  return withNode(file, nodeId, next)
}

/**
 * Set or clear "hidden until it reports again" — for a replaced / removed board, so only a
 * registry or adopted node can be hidden. A new NODE_ID has nothing to hide (it is in the
 * roster because it reports); Ignore is its action. Clearing is allowed for any id, so a stray
 * flag can always be removed.
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
  if (!defaults.has(nodeId) && !adopted(file.nodes[nodeId])) {
    throw new MappingError(
      'Only a registry or adopted node can be hidden — ignore a new node instead'
    )
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
