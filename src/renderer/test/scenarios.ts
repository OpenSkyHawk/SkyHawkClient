// Scenario builders for component tests: main-side state at today's push level (skyhawk-mock.ts).
// One place for them, on top of the shared node fixtures, so every component test describes the
// world the same way. Each builder states its defaults; a test passes whatever differs.
import { emptyCache } from '../../main/hid/calibration/cache-rules'
import {
  appSettings,
  buildConfigFile,
  diffImport,
  parseConfigFile,
  withSectionNotes
} from '../../main/config/config-file'
import { DEFAULT_CONFIG, type ConfigSnapshot, type ImportPreview } from '@shared/config'
import { gatewayStatus } from '../../main/gateway/gateway-health'
import type { DeviceState, DeviceStatus, GatewayStatus } from '@shared/gateway'
import type {
  NodeDefaults,
  NodeMappingFile,
  NodeModel,
  NodeModelEntry,
  NodeStatus,
  NodeTelemSnapshot,
  PduOutage,
  PduRailPage,
  PduStatusPage,
  NodeRegistryInfo,
  ResetPreview
} from '@shared/nodes'
import type { LogEvent } from '@shared/events'
import type { StreamRow, StatsSnapshot, TelemetryReadout } from '@shared/dcs'
import type { SerialFrame } from '@shared/gateway'
import type { CalCache, CalHello, CalRawSample, CalSnapshot } from '@shared/hid/calibration'
import { A4EC_OUTPUTS, CAL_PROTO, TELEM_PAGES } from '@shared/firmware'
import { Decoder } from '../../main/dcs/sim-telemetry-decoder'
import { NODE_KIND, NodeRoster } from '../../main/nodes/node-status-wire'
import { NodeTelemStore } from '../../main/nodes/node-telem'
import { NodeHub, withFaultInfo } from '../../main/nodes/node-hub'
import { modelNode, nodeModel, nodeStatus } from '../../test-fixtures/nodes'
import type { CalDevice } from './skyhawk-mock'

export { modelNode, nodeStatus }

// ── device link (`device:status`) ───────────────────────────────────────────

export const PORT = '/dev/cu.usbmodem1'

/** The device link in `state`; connected and error carry the port, as main sends them. */
export function link(state: DeviceState, over: Partial<DeviceStatus> = {}): DeviceStatus {
  const port = state === 'connected' || state === 'error' ? { portPath: PORT } : {}
  return { state, ...port, ...over }
}

/** Connected, with the Gateway's own health when given. */
export const connected = (gateway?: GatewayStatus): DeviceStatus =>
  link('connected', gateway ? { gateway } : {})

// ── the Gateway's own health (`device:status.gateway`), from main's own builder ─────────────

/**
 * What main computes from the Gateway's node-0 status row (gateway-health.ts gatewayStatus): its
 * health frame has arrived (kind 03), 42 °C, plus `row` (e.g. `{ boff: true }`).
 */
export function gateway(row: Partial<NodeStatus> = {}): GatewayStatus {
  const st = nodeStatus(0, { nodeKind: NODE_KIND.BRIDGE, dieTempC: 42, ...row })
  return gatewayStatus(st, false)!
}

/** A roster request went unanswered for 5 s while the port was open. */
export const gatewayNotResponding = (): GatewayStatus => gatewayStatus(undefined, true)!

// ── node model entries (`nodes:model`) ──────────────────────────────────────

/** NODE_IDS.md consoles come from the name prefix: `Right_Navigation` → `Right`. */
const consoleOf = (name: string) => /^(Left|Center|Right)/.exec(name)?.[1] ?? 'Center'

/** A registry panel group in your cockpit: online, healthy, reported kind 01, no power zone. */
export const panel = (nodeId: number, name: string, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name,
    console: consoleOf(name),
    identified: 'panel',
    status: nodeStatus(nodeId, { nodeKind: NODE_KIND.PANEL_GROUP }),
    ...over
  })

/** A registry PDU in your cockpit: online, healthy, reported kind 02, no fresh pages. */
export const pdu = (nodeId: number, name: string, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name,
    console: consoleOf(name),
    kind: 'pdu',
    identified: 'pdu',
    readings: 'none',
    status: nodeStatus(nodeId, { nodeKind: NODE_KIND.PDU }),
    ...over
  })

/** The roster lists it gone, at `at`. */
export const offline = (at?: number): Partial<NodeModelEntry> => ({
  availability: 'offline',
  offlineVia: 'roster',
  ...(at !== undefined && { offlineAt: at })
})

/** Remembered from an earlier session, missing from this session's first complete roster. */
export const notSeen = (lastSeenAt?: number): Partial<NodeModelEntry> => ({
  availability: 'offline',
  notSeen: true,
  status: undefined,
  ...(lastSeenAt !== undefined && { lastSeenAt })
})

/** No complete roster yet and it hasn't reported: availability unknown. */
export const noStatusYet = (): Partial<NodeModelEntry> => ({
  availability: 'unknown',
  status: undefined
})

/**
 * A board on the bus that isn't in your cockpit: online since `firstSeenAt`, nothing reported
 * about its kind (0) unless `over` says so.
 */
export const newBoard = (nodeId: number, firstSeenAt: number, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name: `Node ${nodeId}`,
    console: null,
    source: 'new',
    firstSeenAt,
    reportedAt: firstSeenAt,
    ...over
  })

/** A PDU outage: the PDU and the fed boards that dropped with it. */
export const outage = (pduId: number, nodeIds: number[], fedCount: number, at = 0): PduOutage => ({
  pduId,
  nodeIds,
  fedCount,
  at
})

/** The model main pushes around these entries; roster complete unless `over` says otherwise. */
export const model = (
  nodes: NodeModelEntry[],
  outages: PduOutage[] = [],
  over: Partial<NodeModel> = {}
): NodeModel => ({ ...nodeModel(nodes, outages), ...over })

// ── main's node hub over a mapping file: the bundled registry and the reset review ─────────

/** Main's NodeHub over node-mapping.json holding `file`, with no device link. */
const hubOver = (file: NodeMappingFile = { version: 3, nodes: {} }) =>
  new NodeHub(
    () => {},
    new NodeRoster(),
    () => {},
    { mappingFile: { read: () => ({ kind: 'read', data: file }), write: () => undefined } }
  )

/** The bundled NODE_IDS.md as main answers `getNodeRegistry` (NodeHub.registry). */
export const bundledRegistry = (): NodeRegistryInfo => hubOver().registry()

/**
 * The review main answers `previewNodeReset` with while node-mapping.json holds `file`
 * (NodeHub.previewReset over the bundled registry).
 */
export const resetPreview = (file: NodeMappingFile): ResetPreview => hubOver(file).previewReset()

// ── config import (`openConfigImport`'s answer) ─────────────────────────────

/** This computer's setup as main snapshots it: the default config, no mapping, no calibration. */
export const setup = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot => ({
  app: appSettings(DEFAULT_CONFIG),
  nodeMapping: { version: 3, nodes: {} },
  powerSupply: DEFAULT_CONFIG.psu,
  calibration: emptyCache(),
  ...over
})

/** An exported file's text holding `sections` as written (not sanitized: what's on disk). */
export const configFileText = (
  sections: Record<string, unknown>,
  exportedAt = '2026-10-12T21:02:00.000Z',
  client = '0.2.0'
): string => JSON.stringify({ ...buildConfigFile(setup(), exportedAt, client), sections }, null, 2)

/**
 * The preview main answers `openConfigImport` with for `text` against `current`, built the way
 * main's ConfigTransfer.preview builds it (parseConfigFile + diffImport + the section notes); the
 * token is fixed.
 */
export function importPreview(
  text: string,
  current: ConfigSnapshot = setup(),
  defaults: Map<number, NodeDefaults> = new Map(),
  fileName = 'skyhawk-config.json'
): ImportPreview {
  const parsed = parseConfigFile(text)
  if (!parsed.ok) throw new Error(`importPreview: main would refuse this file: ${parsed.error}`)
  const { config } = parsed
  const sections = withSectionNotes(diffImport(defaults, current, config.sections))
  return {
    token: 'import-token-1',
    fileName,
    ...(config.exportedAt ? { exportedAt: config.exportedAt } : {}),
    ...(config.client ? { client: config.client } : {}),
    sections,
    skipped: config.skipped,
    identical: sections.every((s) => s.rows.length === 0)
  }
}

// ── node status rows, as main enriches them (`nodes:model` entry `status`) ─────────────────

/**
 * A panel group's status row as main hands it over: kind 01, plus `over`, with the fault table's
 * abbr / label / description filled in for a `faultId` the way NodeHub does (withFaultInfo).
 */
export const reported = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus =>
  withFaultInfo(nodeStatus(nodeId, { nodeKind: NODE_KIND.PANEL_GROUP, ...over }))

// ── PDU telemetry (the pages NodeHub takes), from main's own telemetry store ──────────────

export interface PduPages {
  rail12V?: Partial<Omit<PduRailPage, 'kind' | 'page'>>
  rail5V?: Partial<Omit<PduRailPage, 'kind' | 'page'>>
  status?: Partial<Omit<PduStatusPage, 'kind' | 'page'>>
}

/**
 * What main pushes for a PDU's pages that arrived `ageMs` ago (NodeTelemStore.snapshot): rails
 * default to a healthy 12.00 V / 5.00 V at 0 A, the status page to 30.0 °C, calibrated, no peaks.
 */
export function pduTelemetry(nodeId: number, pages: PduPages, ageMs = 0): NodeTelemSnapshot {
  const store = new NodeTelemStore()
  const rail = (page: PduRailPage['page'], mv: number, over: PduPages['rail12V']) =>
    store.apply(
      { nodeId, kind: 'rail', page, flags: 0, vAvgMv: mv, vMinMv: mv, iAvgMa: 0, ...over },
      0
    )
  if (pages.rail12V) rail(TELEM_PAGES.PDU_RAIL_12V, 12_000, pages.rail12V)
  if (pages.rail5V) rail(TELEM_PAGES.PDU_RAIL_5V, 5_000, pages.rail5V)
  if (pages.status) {
    store.apply(
      {
        nodeId,
        kind: 'status',
        page: TELEM_PAGES.PDU_STATUS,
        flags: 0,
        ntcTempC: 30,
        i12PeakMa: 0,
        i5PeakMa: 0,
        ...pages.status
      },
      0
    )
  }
  return store.snapshot(ageMs)[0]!
}

// ── the relay's ticks: sim telemetry (`telemetry:tick`) and stream stats (`stats:tick`) ─────

/**
 * What main's telemetry tick pushes once DCS has exported `fill` (0 … 1 of each output's range)
 * for the given A-4E-C output ids: the five readouts, from main's own decoder. An output DCS
 * hasn't exported reads NaN ("—").
 */
export function simTelemetry(fill: Record<string, number> = {}): TelemetryReadout[] {
  const decoder = new Decoder()
  for (const [id, f] of Object.entries(fill)) {
    const o = A4EC_OUTPUTS.find((x) => x.id === id)
    if (!o) throw new Error(`simTelemetry: no A-4E-C output ${id}`)
    decoder.handle(o.address, (Math.round(f * o.max) << o.shift) & o.mask, 0)
  }
  return decoder.telemetrySnapshot()
}

/** One stats tick: an idle stream (all zero, no command yet) plus `over`. */
export const streamStats = (over: Partial<StatsSnapshot> = {}): StatsSnapshot => ({
  bytesInPerSec: 0,
  bytesOutPerSec: 0,
  framesPerSec: 0,
  commandsPerSec: 0,
  commandsTotal: 0,
  errors: 0,
  uptimeSec: 0,
  reconnects: 0,
  ...over
})

// ── the session's event log (`events:batch`) ────────────────────────────────

/** One event-log row: node #1 Center_Armament went offline, `id` seconds past 12:00 local. */
export const logEvent = (id: number, over: Partial<LogEvent> = {}): LogEvent => ({
  id,
  t: new Date(2026, 9, 16, 12, 0, id).getTime(),
  source: 'node',
  nodeId: 1,
  name: 'Center_Armament',
  severity: 'error',
  event: 'offline',
  detail: 'no heartbeat',
  raw: `_NODE_STATUS 01000000000000000080000000${id.toString(16).padStart(2, '0')}`,
  ...over
})

// ── the DCS-BIOS stream (`log:batch`) and raw serial (`serial:traffic`) ─────────────────────

/** One stream row: an export from DCS (in) at `address`, at 12:00:00 local unless `over` says. */
export const streamRow = (address: number, over: Partial<StreamRow> = {}): StreamRow => ({
  t: new Date(2026, 9, 16, 12, 0, 0).getTime(),
  dir: 'in',
  address,
  value: 0,
  ...over
})

/** One raw serial chunk, `hex` as main forwards it. */
export const serialFrame = (dir: SerialFrame['dir'], hex: string, t = 0): SerialFrame => ({
  t: t || new Date(2026, 9, 16, 12, 0, 0).getTime(),
  dir,
  hex
})

// ── axis calibration (#46): the Gateway's calibration channel ─────────────────────────────

const CAL_SERIAL = 'E6614103E7452D2F'

/** HELLO_ACK from today's SimGateway firmware. */
const CAL_HELLO: CalHello = {
  proto: CAL_PROTO.version,
  blobVersion: CAL_PROTO.blobVersion,
  axisSlots: CAL_PROTO.axisSlots,
  fw: { major: 0, minor: 2, patch: 0 }
}

export interface CalAxis {
  idx: number
  calibrated?: boolean
  min?: number
  centre?: number
  max?: number
}

/**
 * What GET_CAL reads back: `axes` declared present (uncalibrated unless they say so; a calibrated
 * one defaults to 10000 … 32768 … 55000), every other slot absent; the board's USB serial.
 */
export function calSnapshot(axes: CalAxis[], serialNumber: string = CAL_SERIAL): CalSnapshot {
  const rows = Array.from({ length: CAL_PROTO.axisSlots }, (_, idx) => {
    const a = axes.find((x) => x.idx === idx)
    return {
      idx,
      controlId: 0x10 + idx,
      min: a?.min ?? (a?.calibrated ? 10_000 : 0),
      centre: a?.centre ?? (a?.calibrated ? 32_768 : 0),
      max: a?.max ?? (a?.calibrated ? 55_000 : 0),
      deadzone: 0,
      present: !!a,
      calibrated: !!a?.calibrated
    }
  })
  const mask = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.reduce((m, r) => (f(r) ? m | (1 << r.idx) : m), 0)
  return {
    presentMask: mask((r) => r.present),
    calibratedMask: mask((r) => r.calibrated),
    axes: rows,
    serialNumber
  }
}

/** A calibration-capable Gateway holding `stored`, with the client's cache file as given. */
export const calDevice = (stored: CalSnapshot, over: Partial<CalDevice> = {}): CalDevice => ({
  hello: CAL_HELLO,
  stored,
  ...over
})

/** cal-cache.json holding `axes` for the board `serial`, confirmed at `confirmedAt`. */
export const calCache = (
  axes: Record<number, { min: number; centre: number; max: number; selfCentring: boolean }>,
  confirmedAt = '2026-10-12T21:02:00.000Z',
  serial = CAL_SERIAL
): CalCache => ({ version: 1, boards: { [serial]: { confirmedAt, axes } } })

/**
 * The RAW samples of `count` full sweeps on axis `idx`, from rest to stop `a`, held, then to stop
 * `b`, held — each hold corroborated by a second in-band sample 1.6 s later (the capture needs
 * 1.5 s and a confirming sample). With `rest`, each sweep also releases to `rest` and settles
 * there for the 5 s centre hold. Stamped from `t0`, 100 ms apart where nothing is held.
 */
export function sweeps(
  idx: number,
  t0: number,
  a: number,
  b: number,
  count = 3,
  rest?: number
): CalRawSample[] {
  const out: CalRawSample[] = []
  let t = t0
  const at = (raw: number, dt = 100) => {
    t += dt
    out.push({ t, idx, raw, cal: raw })
  }
  let from = 32_768
  for (let i = 0; i < count; i++) {
    // Each step times the value it lands on, so it starts from where the last one left off.
    at(from)
    at(a)
    at(a + 10, 1600)
    at(a + 10)
    at(b)
    at(b + 10, 1600)
    if (rest !== undefined) {
      at(b + 10)
      at(rest)
      at(rest + 10, 5100)
    }
    from = rest !== undefined ? rest + 10 : b + 10
  }
  return out
}
