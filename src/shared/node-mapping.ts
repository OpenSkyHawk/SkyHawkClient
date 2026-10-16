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

export interface NodeMappingFile {
  version: 1
  nodes: Record<number, NodeOverride>
  /** NODE_IDs the user ignored permanently (never "new"). */
  ignored: number[]
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
  return { version: 1, nodes, ignored }
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
  let n = 0
  for (const m of effectiveMapping(defaults, file).values()) if (m.differs) n++
  return n
}

export type MappingPatch = Partial<Pick<NodeOverride, 'name' | 'console' | 'pduId'>>
export interface AdoptSpec {
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
}

/** Thrown for input the UI should have prevented; main turns it into an error result. */
export class MappingError extends Error {}

function withNode(
  file: NodeMappingFile,
  nodeId: number,
  o: NodeOverride | undefined
): NodeMappingFile {
  const nodes = { ...file.nodes }
  if (o && Object.keys(o).length) nodes[nodeId] = o
  else delete nodes[nodeId]
  return { ...file, nodes }
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
  checkPatch(patch)
  const d = defaults.get(nodeId)
  const cur = file.nodes[nodeId]
  if (!d && !adopted(cur)) throw new MappingError(`Node ${nodeId} is not mapped — adopt it first`)
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
  if (defaults.has(nodeId)) throw new MappingError(`Node ${nodeId} is in the registry`)
  checkPatch(spec)
  if (spec.kind !== 'pdu' && spec.kind !== 'panel') throw new MappingError('Unknown node kind')
  const o: NodeOverride = {
    name: text(spec.name),
    console: text(spec.console),
    pduId: spec.kind === 'pdu' ? null : spec.pduId,
    kind: spec.kind
  }
  return withNode(unignore(file, nodeId), nodeId, o)
}

/** Drop an adopted node (it is "new" again if it reports), or a registry node's overrides. */
export function forgetNode(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  return withNode(file, nodeId, undefined)
}

/**
 * Every registry node back to its defaults. Adopted nodes, the ignore list and hidden flags are
 * not registry overrides, so they stay.
 */
export function resetMapping(
  file: NodeMappingFile,
  defaults: Map<number, NodeDefaults>
): NodeMappingFile {
  const nodes: Record<number, NodeOverride> = {}
  for (const [k, o] of Object.entries(file.nodes)) {
    const id = Number(k)
    if (!defaults.has(id)) nodes[id] = o
    else if (o.hidden) nodes[id] = { hidden: true }
  }
  return { ...file, nodes }
}

function unignore(file: NodeMappingFile, nodeId: number): NodeMappingFile {
  return file.ignored.includes(nodeId)
    ? { ...file, ignored: file.ignored.filter((id) => id !== nodeId) }
    : file
}

/** Ignore permanently, or un-ignore. */
export function setIgnored(file: NodeMappingFile, nodeId: number, on: boolean): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  if (!on) return unignore(file, nodeId)
  if (file.ignored.includes(nodeId)) return file
  return { ...file, ignored: [...file.ignored, nodeId].sort((a, b) => a - b) }
}

/** Set or clear "hidden until it reports again". */
export function setHidden(file: NodeMappingFile, nodeId: number, on: boolean): NodeMappingFile {
  if (!isNodeId(nodeId)) throw new MappingError(`Not a NODE_ID: ${nodeId}`)
  const next: NodeOverride = { ...file.nodes[nodeId] }
  if (on) next.hidden = true
  else delete next.hidden
  return withNode(file, nodeId, next)
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
    if (next.nodes[id]?.hidden) next = setHidden(next, id, false)
  }
  return next
}
