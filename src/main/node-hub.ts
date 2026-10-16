// Node data layer in main: taps `_NODE_TELEM`, owns the node mapping, and pushes the combined
// node picture. Kept out of session.ts so the session only feeds it lines and ticks.
import type {
  NodeMappingResult,
  NodeRegistryInfo,
  NodeSnapshot,
  PushChannel,
  PushChannels
} from '@shared/ipc'
import { BRIDGE_NODE_ID, type NodeRoster, type NodeStatus } from '@shared/nodes'
import { isAdoptableKind, resolveKind, type NodeIdentity } from '@shared/node-kind'
import { NodeTelemStore, parseNodeTelem } from '@shared/node-telem'
import { NodeEventTracker, type LogEventInput } from '@shared/events'
import {
  adoptNode,
  clearReportedHidden,
  effectiveMapping,
  forgetNode,
  MappingError,
  registryDefaults,
  resetMapping,
  resetPreview,
  setHidden,
  setIgnored,
  setNodeMapping,
  type AdoptSpec,
  type MappedNode,
  type MappingPatch,
  type NodeDefaults,
  type NodeKind,
  type NodeMappingFile,
  type ResetOptions,
  type ResetPreview
} from '@shared/node-mapping'
import { buildNodeModel, cameOnline, type NodeModel } from '@shared/node-rules'
import { NODE_NAMES, NODE_REGISTRY_SOURCE } from './reference/node-names.generated'
import { NODE_FAULT_CODES } from './reference/node-status.generated'
import {
  loadNodeMapping,
  MappingSaveError,
  saveNodeMapping,
  type LoadedMapping
} from './node-mapping'
import { debugLog } from './debug'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

/** Shortest gap between `nodes:telemetry` pushes. ~3 PDUs send ~3 frames/s between them. */
const NODE_TELEM_PUSH_MS = 1000

/** Fault-dictionary enrichment: the abbr, label and description for the node's faultId. */
/**
 * Client wording where the generated text reads like firmware notes (the label comes from the enum
 * name, the description from the header comment).
 */
const FAULT_TEXT: Partial<Record<number, { label: string; description: string }>> = {
  0x09: {
    label: 'Duplicate NODE_ID',
    description:
      'another board uses this NODE_ID, so the two are reported as one and this row mixes both'
  }
}

function withFaultInfo(n: NodeStatus): NodeStatus {
  const fc = n.faultId ? NODE_FAULT_CODES[n.faultId] : undefined
  const text = n.faultId ? FAULT_TEXT[n.faultId] : undefined
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
    ignored: (id) => this.mapping().ignored.includes(id),
    // "New on the bus" once a node has identified as something adoptable — not at first sight,
    // and never for the bridge's own row (node 0, our link).
    isNew: (id) =>
      id !== BRIDGE_NODE_ID &&
      !this.mapped().has(id) &&
      !this.mapping().ignored.includes(id) &&
      isAdoptableKind(this.kindOf(id))
  })
  private mappedFor?: NodeMappingFile
  private mappedCache = new Map<number, MappedNode>()

  constructor(
    private readonly emit: Emit,
    private readonly roster: NodeRoster,
    private readonly onEvents: (events: LogEventInput[]) => void = () => {}
  ) {}

  /** Read lazily: the userData path is only safe to touch once the app is up. */
  private store(): LoadedMapping {
    return (this.loaded ??= loadNodeMapping())
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
    if (rosterChanged) this.clearHiddenThatReported()
    if (changed) this.pushModel(now)
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

  forget(nodeId: number): NodeMappingResult {
    return this.update((f) => forgetNode(f, nodeId))
  }

  /** The stored mapping and the registry defaults it applies to — for config export / import. */
  mappingFile(): NodeMappingFile {
    return this.mapping()
  }

  registryDefaults(): Map<number, NodeDefaults> {
    return this.defaults
  }

  /** Replace the whole mapping (config import). Same save path and read-only guard as any edit. */
  replaceMapping(file: NodeMappingFile): NodeMappingResult {
    return this.update(() => file)
  }

  resetAll(opts?: ResetOptions): NodeMappingResult {
    return this.update((f) => resetMapping(f, this.defaults, opts))
  }

  /** What `resetAll` would change, for the review shown before it runs. */
  previewReset(): ResetPreview {
    return resetPreview(this.defaults, this.mapping())
  }

  /** Ignoring records when, and what the node reported as, for Settings › Ignored nodes. */
  ignore(nodeId: number, on: boolean, now = Date.now()): NodeMappingResult {
    const kind = on ? this.knownKind(nodeId, now) : undefined
    const at = new Date(now).toISOString()
    return this.update((f) => setIgnored(f, nodeId, on, kind ? { at, kind } : { at }))
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
      stored: this.defaults.get(nodeId)?.kind ?? this.mapping().nodes[nodeId]?.kind
    })

  /** The kind Ignore records: only an adoptable one (a bridge or unknown kind records none). */
  private knownKind(nodeId: number, now: number): NodeKind | undefined {
    const k = this.kindOf(nodeId, now)
    return isAdoptableKind(k) ? k : undefined
  }

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
   * A replaced / removed board that comes back online is no longer hidden. Only a transition
   * counts: a board the bridge still lists (within its 3 s heartbeat timeout, or about to be
   * removed) stays hidden through later polls. If the save fails the
   * board is still shown — it is reporting, so hiding it would be wrong — and the flag may come
   * back after a restart, which is the lesser problem.
   */
  private clearHiddenThatReported(): void {
    const roster = this.roster.snapshot()
    const back = cameOnline(this.wasPresent, roster)
    this.wasPresent = new Set(roster.filter((n) => n.present).map((n) => n.nodeId))
    const next = clearReportedHidden(this.mapping(), back)
    try {
      this.save(next)
    } catch (err) {
      if (!(err instanceof MappingSaveError)) throw err
      debugLog('nodes.mapping', err.message)
      this.commit(next)
    }
  }

  /** Persist, then adopt in memory — never the other way round, or a failed write looks saved. */
  private save(next: NodeMappingFile): void {
    if (next === this.mapping()) return
    const { readOnly } = this.store()
    if (readOnly) throw new MappingSaveError(`Not saved: ${readOnly}`)
    saveNodeMapping(next)
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
