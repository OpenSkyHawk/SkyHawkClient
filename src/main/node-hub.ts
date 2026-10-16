// Node data layer in main: taps `_NODE_TELEM`, owns the node mapping, and pushes the combined
// node picture. Kept out of session.ts so the session only feeds it lines and ticks.
import type {
  NodeMappingResult,
  NodeRegistryInfo,
  NodeSnapshot,
  PushChannel,
  PushChannels
} from '@shared/ipc'
import type { NodeRoster, NodeStatus } from '@shared/nodes'
import { NodeTelemStore, parseNodeTelem } from '@shared/node-telem'
import {
  adoptNode,
  clearReportedHidden,
  forgetNode,
  MappingError,
  registryDefaults,
  resetMapping,
  resetPreview,
  setHidden,
  setIgnored,
  setNodeMapping,
  type AdoptSpec,
  type MappingPatch,
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

/** Fault-dictionary enrichment, as `nodes:status` carries it. */
function withFaultInfo(n: NodeStatus): NodeStatus {
  const fc = n.faultId ? NODE_FAULT_CODES[n.faultId] : undefined
  return { ...n, faultAbbr: fc?.abbr, faultLabel: fc?.label, faultDesc: fc?.description }
}

export class NodeHub {
  private readonly telem = new NodeTelemStore()
  private readonly defaults = registryDefaults(NODE_NAMES)
  private loaded?: LoadedMapping
  private telemPushedAt = 0
  private modelDirty = true
  /** Present NODE_IDs at the last roster change, to tell "came back" from "still listed". */
  private wasPresent = new Set<number>()

  constructor(
    private readonly emit: Emit,
    private readonly roster: NodeRoster
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
    this.wasPresent.clear()
    this.telemPushedAt = 0
    this.modelDirty = true
  }

  /** One `_NODE_TELEM` argument. Malformed lines are dropped, like `_NODE_STATUS`. */
  telemetry(arg: string, now = Date.now()): void {
    const t = parseNodeTelem(arg.trim())
    if (t) this.telem.apply(t, now)
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
    return this.update((f) => setNodeMapping(f, this.defaults, nodeId, patch))
  }

  adopt(nodeId: number, spec: AdoptSpec): NodeMappingResult {
    return this.update((f) => adoptNode(f, this.defaults, nodeId, spec))
  }

  forget(nodeId: number): NodeMappingResult {
    return this.update((f) => forgetNode(f, nodeId))
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
   * A node's kind only when something says so: the registry, an adoption, or `_NODE_TELEM` (only a
   * PDU sends it). The model's 'panel' for a new node is a display default, not knowledge — stored,
   * it would outrank telemetry that arrives later, and a PDU ignored early would stay a panel.
   */
  private knownKind(nodeId: number, now: number): NodeKind | undefined {
    const known = this.defaults.get(nodeId)?.kind ?? this.mapping().nodes[nodeId]?.kind
    if (known) return known
    return this.telem.snapshot(now).some((t) => t.nodeId === nodeId && t.isPdu) ? 'pdu' : undefined
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
