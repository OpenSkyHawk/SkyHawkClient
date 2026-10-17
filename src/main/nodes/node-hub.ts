// Node data layer in main: taps `_NODE_TELEM`, owns the node mapping, and pushes the combined
// node picture. Kept out of app/session.ts so the session only feeds it lines and ticks.
import type {
  AdoptSpec,
  MappedNode,
  MappingPatch,
  NodeDefaults,
  NodeIdentity,
  NodeMappingFile,
  NodeMappingResult,
  NodeModel,
  NodeRegistryInfo,
  NodeSnapshot,
  NodeStatus,
  ResetOptions,
  ResetPreview
} from '@shared/nodes'
import type { PushChannel, PushChannels } from '@shared/app'
import type { LogEventInput } from '@shared/events'
import {
  adoptNode,
  clearReportedHidden,
  effectiveMapping,
  forgetNode,
  importMapping,
  MappingError,
  markSeen,
  resetMapping,
  resetNode,
  resetPreview,
  setHidden,
  setNodeMapping
} from './mapping-rules'
import {
  NODE_FAULT_CODES,
  NODE_NAMES,
  NODE_REGISTRY_SOURCE,
  type NodeFaultName
} from '@shared/firmware'
import { isAdoptableKind } from '@shared/nodes/legacy-rules'
import { buildNodeModel } from './node-model'
import { NodeEventTracker } from './node-events'
import { resolveKind } from './node-kind'
import { BRIDGE_NODE_ID, type NodeRoster } from './node-status-wire'
import { NodeTelemStore, parseNodeTelem } from './node-telem'
import { registryDefaults } from './registry'
import {
  loadNodeMapping,
  MappingSaveError,
  saveNodeMapping,
  type LoadedMapping,
  type MappingPaths
} from './mapping-store'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

/** Port: the debug log, handed in by app (debug.log lives in app). */
export type Log = (tag: string, data?: unknown) => void

/** What NodeHub needs from app, through DeviceLink: where node-mapping.json lives, and the log. */
export interface NodeHubDeps {
  paths?: MappingPaths
  log?: Log
}

/** Until a path is handed in: fails loudly on first use rather than guess one. */
const NO_PATHS: MappingPaths = {
  nodeMappingFile: () => {
    throw new Error('NodeHub: no node-mapping.json path was handed in')
  }
}

/** Shortest gap between `nodes:telemetry` pushes. ~3 PDUs send ~3 frames/s between them. */
const NODE_TELEM_PUSH_MS = 1000

/** Fault-dictionary enrichment: the abbr, label and description for the node's faultId. */
/**
 * Client wording where the generated text reads like firmware notes (the label comes from the enum
 * name, the description from the header comment). Keyed by NODE_FAULT_CODES name.
 */
const FAULT_TEXT: Partial<Record<NodeFaultName, { label: string; description: string }>> = {
  DUPLICATE_NODE_ID: {
    label: 'Duplicate NODE_ID',
    description:
      'another board uses this NODE_ID, so the two are reported as one and this row mixes both'
  }
}

export function withFaultInfo(n: NodeStatus): NodeStatus {
  const fc = n.faultId ? NODE_FAULT_CODES[n.faultId] : undefined
  const text = fc ? FAULT_TEXT[fc.name] : undefined
  return {
    ...n,
    faultAbbr: fc?.abbr,
    faultLabel: text?.label ?? fc?.label,
    faultDesc: text?.description ?? fc?.description
  }
}

export class NodeHub {
  private readonly telem = new NodeTelemStore()
  private readonly defaults = registryDefaults(NODE_NAMES)
  private loaded?: LoadedMapping
  private telemPushedAt = 0
  private modelDirty = true
  /** Present NODE_IDs at the last roster change, to tell "came back" from "still listed". */
  private wasPresent = new Set<number>()
  /** Node changes for the event log (#64), named by the mapping. */
  private readonly events = new NodeEventTracker({
    name: (id) => this.mapped().get(id)?.name ?? `Node ${id}`,
    // "New on the bus" once a node not in your cockpit has identified as something adoptable — not
    // at first sight, and never for the bridge's own row (node 0, our link). A registry board not
    // added yet is new too (#93); its kind comes from the registry, so it is news at once.
    unmapped: (id) => !this.mapped().get(id)?.known,
    inRegistry: (id) => this.defaults.has(id),
    isNew: (id) =>
      id !== BRIDGE_NODE_ID && !this.mapped().get(id)?.known && isAdoptableKind(this.kindOf(id))
  })
  private mappedFor?: NodeMappingFile
  private mappedCache = new Map<number, MappedNode>()
  private readonly paths: MappingPaths
  private readonly log: Log

  constructor(
    private readonly emit: Emit,
    private readonly roster: NodeRoster,
    private readonly onEvents: (events: LogEventInput[]) => void = () => {},
    deps: NodeHubDeps = {}
  ) {
    this.paths = deps.paths ?? NO_PATHS
    this.log = deps.log ?? (() => {})
  }

  /** Read lazily: the userData path is only safe to touch once the app is up. */
  private store(): LoadedMapping {
    return (this.loaded ??= loadNodeMapping(this.paths))
  }

  private mapping(): NodeMappingFile {
    return this.store().file
  }

  /** New session: telemetry and first-seen times start over; the mapping persists. */
  reset(): void {
    this.telem.reset()
    this.events.reset()
    this.wasPresent.clear()
    this.telemPushedAt = 0
    this.modelDirty = true
  }

  /** One `_NODE_TELEM` argument. Malformed lines are dropped, like `_NODE_STATUS`. */
  telemetry(arg: string, now = Date.now(), line = ''): void {
    const t = parseNodeTelem(arg.trim())
    if (!t) return
    this.telem.apply(t, now)
    this.report(this.events.telemetry(t, line, now))
  }

  /** After a `_NODE_STATUS` / `_NODE_STATUS_END` line reached the roster: what it changed. */
  statusLine(identifier: string, line: string, now = Date.now()): void {
    const roster = this.roster.snapshot().map(withFaultInfo)
    this.report(this.events.status(roster, identifier, line, now))
  }

  private report(events: LogEventInput[]): void {
    if (events.length) this.onEvents(events)
  }

  /** The effective mapping, rebuilt only when the mapping file changes — names for every event. */
  private mapped(): Map<number, MappedNode> {
    const f = this.mapping()
    if (this.mappedFor !== f) {
      this.mappedCache = effectiveMapping(this.defaults, f)
      this.mappedFor = f
    }
    return this.mappedCache
  }

  /** Session tick. Pushes telemetry at most once per NODE_TELEM_PUSH_MS, the model on change. */
  flush(rosterChanged: boolean, now = Date.now()): void {
    let changed = rosterChanged || this.modelDirty
    if (now - this.telemPushedAt >= NODE_TELEM_PUSH_MS && this.telem.takeChanged(now)) {
      this.telemPushedAt = now
      this.emit('nodes:telemetry', this.telem.snapshot(now))
      changed = true
    }
    if (rosterChanged) this.rosterTransitions(now)
    if (changed) this.pushModel(now)
  }

  /**
   * The link is closing (unplug, Disconnect, app quit): every board still on the bus was last seen
   * now (#93). Called before the roster and this hub are reset.
   */
  linkClosed(now = Date.now()): void {
    if (!this.wasPresent.size) return
    this.persist(
      markSeen(this.mapping(), this.defaults, this.wasPresent, new Date(now).toISOString())
    )
    this.wasPresent.clear()
  }

  /** Everything the renderer needs to rehydrate after a reload. */
  snapshot(now = Date.now()): NodeSnapshot {
    return { model: this.model(now), telemetry: this.telem.snapshot(now) }
  }

  setMapping(nodeId: number, patch: MappingPatch): NodeMappingResult {
    return this.update((f) => setNodeMapping(f, this.defaults, nodeId, patch, this.kindOf))
  }

  adopt(nodeId: number, spec: AdoptSpec): NodeMappingResult {
    return this.update((f) => adoptNode(f, this.defaults, nodeId, spec, this.kindOf))
  }

  /** One registry board back to its NODE_IDS.md defaults. */
  resetBoard(nodeId: number): NodeMappingResult {
    return this.update((f) => resetNode(f, this.defaults, nodeId))
  }

  /** Remove a board from your cockpit (#93). Offline only: a board on the bus is active. */
  forget(nodeId: number): NodeMappingResult {
    const online = this.onlineRefusal(nodeId, 'forgotten')
    if (online) return online
    return this.update((f) => forgetNode(f, this.defaults, nodeId, this.kindOf))
  }

  /**
   * Hide and Forget only tidy the display, and a board that is online is active on the bus — its
   * controls reach DCS, it draws power, it affects bus health — so it always shows (#93).
   */
  private onlineRefusal(nodeId: number, what: string): NodeMappingResult | undefined {
    const online = this.roster.snapshot().some((n) => n.nodeId === nodeId && n.present)
    return online
      ? { ok: false, error: `It is online — a board on the bus can’t be ${what}` }
      : undefined
  }

  /** The stored mapping and the registry defaults it applies to — for config export / import. */
  mappingFile(): NodeMappingFile {
    return this.mapping()
  }

  registryDefaults(): Map<number, NodeDefaults> {
    return this.defaults
  }

  /**
   * Config import: the file's settings over the current mapping, keeping what this computer
   * observed — each board's `added` and `lastSeen` — and never hiding a board on the bus (#93).
   * Same save path and read-only guard as any edit.
   */
  importMapping(file: NodeMappingFile): NodeMappingResult {
    return this.update((cur) => importMapping(cur, file, this.onlineIds()))
  }

  /** NODE_IDs present in the roster now (the bridge's own row excluded). */
  onlineIds(): number[] {
    return this.roster
      .snapshot()
      .filter((n) => n.present && n.nodeId !== BRIDGE_NODE_ID)
      .map((n) => n.nodeId)
  }

  resetAll(opts?: ResetOptions): NodeMappingResult {
    return this.update((f) => resetMapping(f, this.defaults, opts))
  }

  /** What `resetAll` would change, for the review shown before it runs. */
  previewReset(): ResetPreview {
    return resetPreview(this.defaults, this.mapping())
  }

  /**
   * What a node is, by the one resolver the model uses (node-kind.ts): its own announcement, then
   * PDU telemetry, then the registry or an adoption. undefined = nothing solid yet — the model's
   * 'panel' for a new node is a display default, never knowledge.
   */
  private readonly kindOf = (nodeId: number, now = Date.now()): NodeIdentity | undefined =>
    resolveKind({
      reported: this.roster.snapshot().find((n) => n.nodeId === nodeId)?.nodeKind,
      pduTelemetry: this.telem.snapshot(now).some((t) => t.nodeId === nodeId && t.isPdu),
      // Only a board in your cockpit has a stored kind; a new one (registry included) is what it
      // reports, never what its NODE_ID suggests (#93).
      stored: this.mapped().get(nodeId)?.known ? this.mapped().get(nodeId)?.kind : undefined
    })

  /** The bundled NODE_IDS registry, PanelBridge included, and where it came from. */
  registry(): NodeRegistryInfo {
    const nodes = Object.entries(NODE_NAMES)
      .map(([k, v]): NodeRegistryInfo['nodes'][number] => {
        const nodeId = Number(k)
        const kind = this.defaults.get(nodeId)?.kind ?? 'bridge'
        return { nodeId, name: v.name, console: v.console, kind }
      })
      .sort((a, b) => a.nodeId - b.nodeId)
    return { ...NODE_REGISTRY_SOURCE, nodes }
  }

  hide(nodeId: number, on: boolean): NodeMappingResult {
    if (on) {
      const online = this.onlineRefusal(nodeId, 'hidden')
      if (online) return online
    }
    return this.update((f) => setHidden(f, this.defaults, nodeId, on))
  }

  private model(now: number): NodeModel {
    return buildNodeModel({
      roster: this.roster.snapshot().map(withFaultInfo),
      seen: this.roster.seenInfo(),
      rosterCompleteAt: this.roster.rosterCompleteAt(),
      telemetry: this.telem.snapshot(now),
      defaults: this.defaults,
      file: this.mapping()
    })
  }

  private pushModel(now = Date.now()): NodeModel {
    const model = this.model(now)
    this.modelDirty = false
    this.emit('nodes:model', model)
    return model
  }

  /**
   * What a roster change means for the saved mapping:
   * - a board that came (back) online is no longer hidden, and it was seen now — that is how a
   *   registry board joins your cockpit the first time it reports;
   * - a board that dropped off was last seen now.
   * Only transitions count: a board the bridge still lists (within its 3 s heartbeat timeout, or
   * about to be removed) stays hidden through later polls, and steady polls write nothing.
   */
  private rosterTransitions(now: number): void {
    const present = new Set(
      this.roster
        .snapshot()
        .filter((n) => n.present)
        .map((n) => n.nodeId)
    )
    const came = [...present].filter((id) => !this.wasPresent.has(id))
    const went = [...this.wasPresent].filter((id) => !present.has(id))
    this.wasPresent = present
    if (!came.length && !went.length) return
    const at = new Date(now).toISOString()
    this.persist(
      markSeen(clearReportedHidden(this.mapping(), came), this.defaults, [...came, ...went], at)
    )
  }

  /**
   * Save a change main made on its own (not a user edit). If the save fails the change still
   * applies in memory — a reporting board must show, so un-hiding it is right — and may be lost
   * after a restart, which is the lesser problem.
   */
  private persist(next: NodeMappingFile): void {
    try {
      this.save(next)
    } catch (err) {
      if (!(err instanceof MappingSaveError)) throw err
      this.log('nodes.mapping', err.message)
      this.commit(next)
    }
  }

  /** Persist, then adopt in memory — never the other way round, or a failed write looks saved. */
  private save(next: NodeMappingFile): void {
    if (next === this.mapping()) return
    const { readOnly } = this.store()
    if (readOnly) throw new MappingSaveError(`Not saved: ${readOnly}`)
    saveNodeMapping(next, this.paths)
    this.commit(next)
  }

  private commit(next: NodeMappingFile): void {
    this.store().file = next
    this.modelDirty = true
  }

  /** Apply one mapping change, persist it, and push the new model straight away. */
  private update(fn: (f: NodeMappingFile) => NodeMappingFile): NodeMappingResult {
    const before = this.mapping()
    let next: NodeMappingFile
    try {
      next = fn(before)
      this.save(next)
    } catch (err) {
      if (err instanceof MappingError || err instanceof MappingSaveError) {
        return { ok: false, error: err.message }
      }
      throw err
    }
    // A no-op change (forget an unmapped id, hide a hidden node) writes and pushes nothing.
    return { ok: true, model: next === before ? this.model(Date.now()) : this.pushModel() }
  }
}
