// Node data layer in main: the node roster and its 5 s poll, the node lines the Gateway's line
// tap hands it (`_NODE_STATUS`, `_NODE_TELEM`), the Gateway's own health (it drives GatewayWatch,
// UD-C), the node mapping (through MappingStore), and the combined node picture it pushes. It
// rides on the Gateway connection (its `rider`, a gateway LinkRider) and writes the roster request
// through the connection's write (R2.2b). It also hosts the Cockpit snapshot (R3.2): built from
// each node push and the link, and pushed with them on `cockpit:snapshot`.
import type {
  AdoptRequest,
  AdoptSpec,
  MappedNode,
  MappingPatch,
  NodeDefaults,
  NodeIdentity,
  NodeBatchResult,
  NodeMappingFile,
  NodeMappingResult,
  NodeModel,
  NodeRegistryInfo,
  NodeSnapshot,
  NodeStatus,
  ResetOptions,
  ResetPreview
} from '@shared/nodes'
import type { Emit } from '@shared/app'
import type { LogEventInput } from '@shared/events'
import type { DeviceStatus, GatewayStatus } from '@shared/gateway'
import { GatewayWatch, type LinkRider, type NodeLineSink } from '../gateway'
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
import { buildNodeModel } from './node-model'
import { NodeEventTracker } from './node-events'
import { isAdoptableKind, resolveKind } from './node-kind'
import {
  BRIDGE_NODE_ID,
  canRequestRoster,
  cleanNodeLine,
  isLegacyNodeStatus,
  NODE_END_MSG,
  NODE_MSG,
  nodeRosterRequest,
  parseNodeStatus,
  type NodeRoster
} from './node-status-wire'
import { NODE_TELEM_MSG, NodeTelemStore, parseNodeTelem } from './node-telem'
import { registryDefaults } from './registry'
import {
  MappingSaveError,
  MappingStore,
  type MappingFileEvents,
  type MappingFileIO
} from './mapping-store'
import { CockpitSnapshotHost } from './cockpit-host'
import { addAllInTurn, unhideInTurn } from './mapping-sequence'

/** Port: the debug log, handed in by app (debug.log lives in app). */
export type Log = (tag: string, data?: unknown) => void

/**
 * What NodeHub needs of the Gateway link (gateway GatewayConnection): whether a port is held and
 * the link is up, the write the roster request goes out through, whether a calibration exchange
 * holds the link, and where the Gateway's health is pushed.
 */
export interface NodeHubLink {
  readonly attached: boolean
  deviceStatus(): DeviceStatus
  write(data: Buffer): void
  readonly exportGated: boolean
  pushGatewayHealth(gateway: GatewayStatus | undefined): void
}

/** No link (a hub on its own, as the unit tests build one): nothing is requested. */
const NO_LINK: NodeHubLink = {
  attached: false,
  deviceStatus: () => ({ state: 'disconnected' }),
  write: () => {},
  exportGated: false,
  pushGatewayHealth: () => {}
}

/**
 * What NodeHub needs from app: the node-mapping.json port and where its load problems are
 * reported, the log, and the Gateway link.
 */
export interface NodeHubDeps {
  mappingFile?: MappingFileIO
  mappingEvents?: MappingFileEvents
  log?: Log
  link?: NodeHubLink
}

/** Shortest gap between takes of the PDU pages. ~3 PDUs send ~3 frames/s between them. */
const NODE_TELEM_PUSH_MS = 1000
/** The roster poll. */
const NODES_REFRESH_MS = 5000

type Unsubscribe = () => void

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

export class NodeHub implements NodeLineSink {
  private readonly telem = new NodeTelemStore()
  /** The Gateway's own health (#94): its node-0 row, and whether it still answers. */
  private readonly gateway = new GatewayWatch()
  /** A v2 (pre-#344) PanelBridge was reported this link: say it once, not on every row. */
  private legacyNodesWarned = false
  private readonly link: NodeHubLink
  private readonly log: Log
  private readonly errorCbs = new Set<(tag: string, message: string) => void>()
  private readonly defaults = registryDefaults(NODE_NAMES)
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
  /** The node mapping and its file. */
  private readonly store: MappingStore
  /** The Cockpit tab's picture (R3.2), pushed on `cockpit:snapshot` with each node push. */
  private readonly cockpit: CockpitSnapshotHost

  constructor(
    private readonly emit: Emit,
    private readonly roster: NodeRoster,
    private readonly onEvents: (events: LogEventInput[]) => void = () => {},
    deps: NodeHubDeps = {}
  ) {
    this.link = deps.link ?? NO_LINK
    this.log = deps.log ?? (() => {})
    this.store = new MappingStore({
      file: deps.mappingFile,
      log: deps.log,
      events: deps.mappingEvents,
      onCommit: () => {
        this.modelDirty = true
      }
    })
    this.cockpit = new CockpitSnapshotHost((snapshot) => this.emit('cockpit:snapshot', snapshot), {
      device: () => this.link.deviceStatus(),
      registry: () => this.registry()
    })
  }

  private mapping(): NodeMappingFile {
    return this.store.mapping()
  }

  /** Faults worth showing the user: a v2 Gateway (the same path as the link's own). */
  onError(cb: (tag: string, message: string) => void): Unsubscribe {
    this.errorCbs.add(cb)
    return () => this.errorCbs.delete(cb)
  }

  // ── the link's moments (gateway LinkRider) ────────────────────────────────

  /** NodeHub's part of the Gateway connection's moments. AppServices rides it after HID. */
  readonly rider: LinkRider = {
    // Poll the node roster so silent deaths get reconciled — relaying or not.
    timers: (every) => every(NODES_REFRESH_MS, () => this.requestNodes()),
    // Shutdown, Disconnect, unplug: the boards on the bus were last seen now (#93).
    closing: () => this.linkClosed(),
    released: () => this.gateway.reset(),
    // A port open: the roster, the node data and the Gateway's health start over, together.
    opening: () => {
      this.roster.reset()
      this.reset()
      this.gateway.reset()
      this.legacyNodesWarned = false
    },
    connected: () => {
      this.gateway.takeChanged() // just sent, on the connected status
      this.requestNodes() // seed the roster as soon as the device is up
    },
    // The link's push tick, while it is up: node pushes, then the Gateway's health.
    tick: () => {
      this.flush(this.roster.takeDirty())
      this.onEvents(this.gateway.tick(Date.now(), this.link.exportGated))
      if (this.gateway.takeChanged()) {
        this.link.pushGatewayHealth(this.gateway.status())
        this.cockpit.linkChanged()
      }
    }
  }

  /** `device:status` went out with a new link state (the connection's onStatus). */
  linkStatus(): void {
    this.cockpit.linkChanged()
  }

  /**
   * A renderer (re)loaded (`relay:status`, its first pull): the Cockpit snapshot starts over from
   * what main holds now, as the renderer's store did from its `nodes:get`.
   */
  rendererLoaded(now = Date.now()): void {
    const { model, telemetry } = this.snapshot(now)
    this.cockpit.rendererLoaded(model, telemetry)
  }

  /** App quit: the Cockpit's stray timer stops. */
  dispose(): void {
    this.cockpit.dispose()
  }

  /** The Gateway's health as it stands, for the connected status. */
  gatewayHealth(): GatewayStatus | undefined {
    return this.gateway.status()
  }

  /** A roster request can go out now (canRequestRoster): Connection's Refresh (R3.4a). */
  canRefresh(): boolean {
    return canRequestRoster(this.link.attached, this.link.deviceStatus().state)
  }

  /** Ask PanelBridge for the full node roster (inject the request export to the serial). */
  requestNodes(): void {
    if (!this.canRefresh()) return
    this.roster.beginBurst() // isolate the reply burst so prior deltas don't block pruning
    this.gateway.asked(Date.now())
    this.link.write(Buffer.from(nodeRosterRequest()))
  }

  // ── node lines (gateway NodeLineSink) ─────────────────────────────────────

  cleanLine(raw: string): string {
    return cleanNodeLine(raw)
  }

  /** One line from the Gateway's line tap. True for a node line: tapped here, not a command. */
  nodeLine(identifier: string, arg: string, line: string, t: number): boolean {
    if (identifier === NODE_MSG && !this.legacyNodesWarned && isLegacyNodeStatus(arg.trim())) {
      // Every v2 row would be dropped as malformed, leaving the Cockpit silently empty.
      this.legacyNodesWarned = true
      this.raise(
        'NODES',
        'The Gateway sends node status v2; this client needs v3 — update the Gateway firmware (OpenSkyhawk#344)'
      )
    }
    // Node-status messages are tapped to the roster, not logged as panel commands.
    if (identifier === NODE_MSG || identifier === NODE_END_MSG) {
      this.log('node', `${identifier} ${arg}`.trim())
      this.roster.applyMessage(identifier, arg, t)
      this.statusLine(identifier, line, t)
      this.gatewayLine(identifier, arg, line, t)
      return true
    }
    if (identifier === NODE_TELEM_MSG) {
      // Node telemetry (~1/s per PDU) likewise: tapped, never logged as a panel command.
      this.telemetry(arg, t, line)
      return true
    }
    return false
  }

  /**
   * Any node-status line answers the roster request; the Gateway's own row (node 0) is its health.
   * That row stays out of the cockpit model (node-model); this is where it is shown instead (#94).
   */
  private gatewayLine(identifier: string, arg: string, raw: string, t: number): void {
    this.onEvents(this.gateway.answered(raw, t))
    if (identifier !== NODE_MSG) return
    const n = parseNodeStatus(arg.trim())
    if (n?.nodeId === BRIDGE_NODE_ID) this.onEvents(this.gateway.report(withFaultInfo(n), raw, t))
  }

  private raise(tag: string, message: string): void {
    for (const cb of this.errorCbs) cb(tag, message)
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

  /**
   * The link's tick. Takes the PDU pages at most once per NODE_TELEM_PUSH_MS (the Cockpit snapshot
   * and the model follow them), and pushes the model on change.
   */
  flush(rosterChanged: boolean, now = Date.now()): void {
    let changed = rosterChanged || this.modelDirty
    if (now - this.telemPushedAt >= NODE_TELEM_PUSH_MS && this.telem.takeChanged(now)) {
      this.telemPushedAt = now
      // The Cockpit's snapshot follows the pages; the renderer reads them only through it (R3.4d:
      // the `nodes:telemetry` push it no longer listened to is gone).
      this.cockpit.telemetryPushed(this.telem.snapshot(now))
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
    this.store.persist(
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

  /**
   * "Add all" (R3.2b, the Adopt dialog's loop until then): adopt each board in turn, as one adopt
   * each — every one pushes the model as it lands — stopping at the first refusal.
   */
  addAll(bulk: AdoptRequest[]): Promise<NodeBatchResult> {
    return addAllInTurn(bulk, (nodeId, spec) => this.adopt(nodeId, spec))
  }

  /** "Un-hide" / "Un-hide all" (R3.2b, Settings' loop until then): the same, one un-hide each. */
  unhide(ids: number[]): Promise<NodeBatchResult> {
    return unhideInTurn(ids, (nodeId, on) => this.hide(nodeId, on))
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
    this.cockpit.modelPushed(model) // just ahead of the push it mirrors
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
    this.store.persist(
      markSeen(clearReportedHidden(this.mapping(), came), this.defaults, [...came, ...went], at)
    )
  }

  /** Apply one mapping change, persist it, and push the new model straight away. */
  private update(fn: (f: NodeMappingFile) => NodeMappingFile): NodeMappingResult {
    const before = this.mapping()
    let next: NodeMappingFile
    try {
      next = fn(before)
      this.store.save(next)
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
