// Event log (#64): what the client observed, node and client, as a session list (pure, no
// Node/Electron deps). In memory only — never written to the debug log — and cleared on Clear or
// restart. Node events come from changes in the boards' own reports (`_NODE_STATUS`,
// `_NODE_TELEM`): the client never applies a threshold, so every alert here is a flag a board
// raised itself.
import type { DeviceStatus, RelayState, SourceMode } from './ipc'
import { BRIDGE_NODE_ID, NODE_END_MSG, ROSTER_REPLY_MS, type NodeStatus } from './nodes'
import {
  displayCurrentMa,
  PDU_FLAG,
  RAIL_FLAG,
  TELEM_PAGE,
  type NodeTelem,
  type PduRailPage
} from './node-telem'

export type EventSource = 'node' | 'client'

/** error ✕ (offline / failure), warn ! (a raised flag), new + (new on the bus), info ● (cleared / up). */
export type EventSeverity = 'error' | 'warn' | 'new' | 'info'

export const SEVERITY_GLYPH: Record<EventSeverity, string> = {
  error: '✕',
  warn: '!',
  new: '+',
  info: '●'
}

export interface LogEventInput {
  t: number
  source: EventSource
  /** Node events about one node; absent for the roster summary and client events. */
  nodeId?: number
  /** Node: its effective name. Client: `SERIAL`, `DCS`, `Gateway` or `Relay`. */
  name: string
  severity: EventSeverity
  /** What happened, e.g. `5V UNDER-V raised`, `offline`, `connected`. */
  event: string
  /** The reading or reason that goes with it, e.g. `4.71 V`, `no heartbeat`. */
  detail?: string
  /** The source line: the `_NODE_STATUS` / `_NODE_TELEM` frame, or the original client message. */
  raw: string
}

export interface LogEvent extends LogEventInput {
  /** Increasing for the whole app run; never reused, not even after Clear. */
  id: number
}

/** `event · detail`, as the Events view and the Cockpit box print it. */
export function eventText(e: Pick<LogEvent, 'event' | 'detail'>): string {
  return e.detail ? `${e.event} · ${e.detail}` : e.event
}

/** What "Problems only" keeps: something is wrong — not a new node, a cleared flag or a link up. */
export function isProblem(e: Pick<LogEvent, 'severity'>): boolean {
  return e.severity === 'error' || e.severity === 'warn'
}

// ── node events ─────────────────────────────────────────────────────────────

/** What the node mapping says about an id, as the tracker needs it. */
export interface NodeLookup {
  /** Effective name; `Node <id>` when the id has none. */
  name(nodeId: number): string
  /** Neither in the registry nor adopted, and identified as something adoptable: news. */
  isNew(nodeId: number): boolean
  /** Not in your cockpit (not added, not adopted), whatever it has identified as. */
  unmapped(nodeId: number): boolean
  /** In NODE_IDS.md — a new one is waiting to be added, pre-filled (#93). Absent = never. */
  inRegistry?(nodeId: number): boolean
}

export type StatusFlag = 'boff' | 'epvf' | 'degraded' | 'overheat'

/** A node's own heartbeat / health flags, as every row and the Gateway (#94) name them. */
export const STATUS_FLAGS: { key: StatusFlag; label: string; severity: EventSeverity }[] = [
  { key: 'boff', label: 'bus-off', severity: 'error' },
  { key: 'epvf', label: 'error-passive', severity: 'warn' },
  { key: 'degraded', label: 'degraded', severity: 'warn' },
  { key: 'overheat', label: 'overheat', severity: 'warn' }
]

/** Rail flag text, as the Cockpit prints it (`5V UNDER-V`). */
const RAIL_FLAGS: [number, string][] = [
  [RAIL_FLAG.UNDER_V, 'UNDER-V'],
  [RAIL_FLAG.OVER_V, 'OVER-V'],
  [RAIL_FLAG.OVER_CURRENT, 'OVER-I'],
  [RAIL_FLAG.FUSE_OPEN, 'FUSE OPEN'],
  [RAIL_FLAG.SENSOR_FAULT, 'SENSOR FAULT']
]

/** UNCAL_* are calibration state, not alerts (as on the Cockpit), so they are info. */
const PDU_STATUS_FLAGS: [number, string, EventSeverity][] = [
  [PDU_FLAG.TEMP_CRIT, 'TEMP CRIT', 'warn'],
  [PDU_FLAG.TEMP_WARN, 'TEMP WARN', 'warn'],
  [PDU_FLAG.NTC_FAULT, 'NTC FAULT', 'warn'],
  [PDU_FLAG.UNCAL_VDDA, 'UNCAL VDDA', 'info'],
  [PDU_FLAG.UNCAL_ZERO, 'UNCAL ZERO', 'info']
]

const TEMP_FLAGS = PDU_FLAG.TEMP_CRIT | PDU_FLAG.TEMP_WARN

const volts = (mv: number): string => `${(mv / 1000).toFixed(2)} V`

/** The reading that goes with a raised rail flag: the window minimum for under-voltage. */
function railReading(bit: number, p: PduRailPage): string {
  if (bit === RAIL_FLAG.UNDER_V) return volts(p.vMinMv)
  if (bit === RAIL_FLAG.OVER_CURRENT) return `${(displayCurrentMa(p.iAvgMa) / 1000).toFixed(2)} A`
  return volts(p.vAvgMv)
}

/** The fault-dictionary label, else `Fault N`. */
export function faultLabel(n: Pick<NodeStatus, 'faultId' | 'faultLabel'>): string {
  return n.faultLabel ?? `Fault ${n.faultId}`
}

/**
 * Turns the node reports the client receives into change events.
 *
 * Keeps its own last-seen state per node, so a roster poll that repeats what is already known
 * produces nothing. After every port open (`reset`) the first roster is a baseline: nodes found
 * online there are one "N nodes online" row, not N; problems already present (offline, a flag
 * raised) still get their own rows, since nothing else would show them.
 */
export class NodeEventTracker {
  private prev = new Map<number, NodeStatus>()
  private pages = new Map<string, number>()
  private baseline = true
  private baselineAt?: number
  /** New ids reported this app run — kept through a port reopen, so a replug does not repeat them. */
  private newSeen = new Set<number>()

  constructor(private readonly lookup: NodeLookup) {}

  /** A port open: a different board, or the same one after an outage. Its state starts over. */
  reset(): void {
    this.prev.clear()
    this.pages.clear()
    this.baseline = true
    this.baselineAt = undefined
  }

  /**
   * After one `_NODE_STATUS` / `_NODE_STATUS_END` line was applied to the roster: the roster as it
   * now stands (fault labels filled in), and the line that changed it.
   */
  status(roster: NodeStatus[], identifier: string, raw: string, now: number): LogEventInput[] {
    const out: LogEventInput[] = []
    const isEnd = identifier === NODE_END_MSG
    this.baselineAt ??= now
    // A bridge that never ends its roster reply: the baseline closes once the reply window passes.
    if (this.baseline && !isEnd && now - this.baselineAt > ROSTER_REPLY_MS) {
      out.push(this.endBaseline('', now))
    }
    for (const n of roster) {
      // The bridge's own row (node 0, v3) is this client's link: no events, not in the counts.
      if (n.nodeId === BRIDGE_NODE_ID) continue
      const p = this.prev.get(n.nodeId)
      this.prev.set(n.nodeId, n)
      out.push(...this.diff(p, n, raw, isEnd, now))
    }
    if (isEnd && this.baseline) out.push(this.endBaseline(raw, now))
    return out
  }

  /** One decoded `_NODE_TELEM` frame: PDU rail / status flags raised and cleared. */
  telemetry(t: NodeTelem, raw: string, now: number): LogEventInput[] {
    if (t.kind === 'unknown') return []
    const key = `${t.nodeId}:${t.page}`
    const was = this.pages.get(key) ?? 0
    this.pages.set(key, t.flags)
    if (was === t.flags) return []
    const out: LogEventInput[] = []
    const ev = (bit: number, text: string, severity: EventSeverity, reading?: string): void => {
      const on = (t.flags & bit) !== 0
      if (on === ((was & bit) !== 0)) return
      out.push({
        t: now,
        source: 'node',
        nodeId: t.nodeId,
        name: this.lookup.name(t.nodeId),
        severity: on ? severity : 'info',
        event: `${text} ${on ? 'raised' : 'cleared'}`,
        detail: on ? reading : undefined,
        raw
      })
    }
    if (t.kind === 'rail') {
      const rail = t.page === TELEM_PAGE.PDU_RAIL_12V ? '12V' : '5V'
      for (const [bit, text] of RAIL_FLAGS) {
        ev(bit, `${rail} ${text}`, 'warn', railReading(bit, t))
      }
    } else {
      const temp = t.ntcTempC === null ? undefined : `${t.ntcTempC.toFixed(1)} °C`
      for (const [bit, text, severity] of PDU_STATUS_FLAGS) {
        ev(bit, text, severity, bit & TEMP_FLAGS ? temp : undefined)
      }
    }
    return out
  }

  private endBaseline(raw: string, now: number): LogEventInput {
    this.baseline = false
    let online = 0
    for (const n of this.prev.values()) if (n.present) online++
    return {
      t: now,
      source: 'node',
      name: 'roster',
      severity: 'info',
      event: `${online} node${online === 1 ? '' : 's'} online`,
      raw
    }
  }

  private diff(
    p: NodeStatus | undefined,
    n: NodeStatus,
    raw: string,
    isEnd: boolean,
    now: number
  ): LogEventInput[] {
    const out: LogEventInput[] = []
    const id = n.nodeId
    const ev = (severity: EventSeverity, event: string, detail?: string): void => {
      out.push({
        t: now,
        source: 'node',
        nodeId: id,
        name: this.lookup.name(id),
        severity,
        event,
        detail,
        raw
      })
    }
    const emittedNew = n.present && this.lookup.isNew(id) && !this.newSeen.has(id)
    if (emittedNew) {
      this.newSeen.add(id)
      ev(
        'new',
        'new on the bus',
        this.lookup.inRegistry?.(id) ? 'in NODE_IDS.md' : 'not in registry'
      )
    }
    const wasPresent = p?.present ?? false
    if (!n.present && (p === undefined || wasPresent)) {
      // A live delta is the bridge's heartbeat timeout; a roster end finds a node missing from it.
      ev('error', 'offline', isEnd ? 'missing from roster' : 'no heartbeat')
    } else if (n.present && !wasPresent) {
      // A first sighting the baseline counts in its summary row, or that just made its "new" row,
      // needs no "online" too; nor does an unmapped node not yet announced — it gets one "new on
      // the bus" row once it identifies (#344). A new node seen in an earlier port session does:
      // it has no other row.
      const first = p === undefined
      const unannounced = this.lookup.unmapped(id) && !this.newSeen.has(id)
      if (!first || !(this.baseline || emittedNew || unannounced)) ev('info', 'online')
    }
    return this.flagsFrom(wasPresent ? p : undefined, n, ev, out)
  }

  /** Flags only mean something while the node reports; one coming back reports them afresh. */
  private flagsFrom(
    was: NodeStatus | undefined,
    n: NodeStatus,
    ev: (severity: EventSeverity, event: string, detail?: string) => void,
    out: LogEventInput[]
  ): LogEventInput[] {
    if (!n.present) return out
    for (const f of STATUS_FLAGS) {
      const before = was?.[f.key] ?? false
      const on = n[f.key]
      if (f.key === 'degraded' && on && before && was!.faultId !== n.faultId) {
        ev('warn', 'degraded', faultLabel(n))
      } else if (on && !before) {
        const detail =
          f.key === 'degraded' ? faultLabel(n) : f.key === 'epvf' ? `TEC ${n.tec}` : undefined
        ev(f.severity, f.label, detail)
      } else if (!on && before) {
        ev('info', `${f.label} cleared`)
      }
    }
    return out
  }
}

// ── client events ───────────────────────────────────────────────────────────

/** A client diagnostic — the `SERIAL` / `DCS` errors the Stream used to show as `! SYS`. */
export function clientErrorEvent(tag: string, message: string, now: number): LogEventInput {
  return {
    t: now,
    source: 'client',
    name: tag,
    severity: 'error',
    event: tag === 'SERIAL' ? 'serial port error' : tag === 'DCS' ? 'link error' : 'error',
    detail: message,
    raw: `${tag} Error: ${message}`
  }
}

/**
 * A device-link change worth a row, or null. `last` is the last state other than `scanning`,
 * which never makes a row — it comes and goes on every retry — so a retry loop of
 * scanning → no-device → scanning adds nothing after its first "no device".
 */
export function deviceEvent(
  last: DeviceStatus['state'] | undefined,
  next: DeviceStatus,
  now: number
): LogEventInput | null {
  if (next.state === 'scanning' || next.state === last) return null
  const base = { t: now, source: 'client' as const, name: 'Gateway' }
  const raw = ['device:', next.state, next.portPath, next.detail].filter(Boolean).join(' ')
  switch (next.state) {
    case 'connected':
      return { ...base, severity: 'info', event: 'connected', detail: next.portPath, raw }
    case 'reconnecting':
      return { ...base, severity: 'warn', event: 'reconnecting', detail: 'link dropped', raw }
    case 'error':
      // The link raises the same failure as a SERIAL error, which already makes the row.
      return null
    case 'no-device':
      // Launching (or pressing Connect) with nothing plugged in is a resting state, not news.
      if (last === undefined || last === 'disconnected') return null
      return { ...base, severity: 'warn', event: 'no device', detail: 'unplugged', raw }
    case 'disconnected':
      return { ...base, severity: 'info', event: 'disconnected', raw }
  }
}

export interface RelayContext {
  mode: SourceMode
  /** Where the DCS-BIOS stream comes from, e.g. `127.0.0.1:7778`. */
  endpoint: string
  /** TCP connects; UDP only binds, so "connected" there is "listening". */
  tcp: boolean
}

const MODE_LABEL: Record<SourceMode, string> = {
  bridge: 'Bridge mode',
  monitor: 'Monitor mode',
  replay: 'Replay'
}

/**
 * Relay started / stopped, and the DCS-BIOS stream coming up or dropping while it runs. A stream
 * error is not repeated here: the transport's own error already makes a `DCS` row, and the
 * reconnect attempts that follow it are not rows either.
 */
export function relayEvents(
  prev: RelayState,
  next: RelayState,
  ctx: RelayContext,
  now: number
): LogEventInput[] {
  const relay = { t: now, source: 'client' as const, name: 'Relay' }
  const dcs = { t: now, source: 'client' as const, name: 'DCS' }
  const out: LogEventInput[] = []
  if (!prev.running && next.running) {
    out.push({
      ...relay,
      severity: 'info',
      event: 'started',
      detail: MODE_LABEL[ctx.mode],
      raw: `relay: start (${ctx.mode})`
    })
  } else if (prev.running && !next.running) {
    out.push({ ...relay, severity: 'info', event: 'stopped', raw: 'relay: stop' })
  }
  if (!next.running || prev.stream === next.stream) return out
  if (ctx.mode === 'replay') {
    if (next.stream === 'ended') {
      out.push({ ...relay, severity: 'info', event: 'replay ended', raw: 'relay: replay ended' })
    }
  } else if (next.stream === 'connected') {
    out.push({
      ...dcs,
      severity: 'info',
      event: ctx.tcp ? 'link up' : 'listening',
      detail: ctx.endpoint,
      raw: `DCS: connected ${ctx.endpoint}`
    })
  } else if (next.stream === 'reconnecting' && prev.stream === 'connected') {
    // Only a link that was up dropping: retries after an error are that error's row, once.
    out.push({
      ...dcs,
      severity: 'warn',
      event: 'reconnecting',
      detail: ctx.endpoint,
      raw: `DCS: reconnecting ${ctx.endpoint}`
    })
  }
  return out
}

// ── the session list ────────────────────────────────────────────────────────

/** Oldest rows go first once the session holds this many. */
export const MAX_EVENTS = 5000

/** The session's events, oldest first, plus what has not been pushed to the renderer yet. */
export class EventLog {
  private rows: LogEvent[] = []
  private pending: LogEvent[] = []
  private nextId = 1

  constructor(private readonly max = MAX_EVENTS) {}

  add(inputs: LogEventInput[]): void {
    for (const input of inputs) {
      const e = { ...input, id: this.nextId++ }
      this.rows.push(e)
      this.pending.push(e)
    }
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max)
    if (this.pending.length > this.max) this.pending.splice(0, this.pending.length - this.max)
  }

  /** Rows added since the last call, oldest first. */
  take(): LogEvent[] {
    const p = this.pending
    this.pending = []
    return p
  }

  snapshot(): LogEvent[] {
    return [...this.rows]
  }

  clear(): void {
    this.rows = []
    this.pending = []
  }
}

// ── export ──────────────────────────────────────────────────────────────────

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Local time, `2026-10-16 21:14:07.412`. */
export function fmtDateTime(t: number): string {
  const d = new Date(t)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

/** A tab or line break inside a field would shift every column after it. */
const cell = (s: string | number | undefined): string =>
  s === undefined ? '' : String(s).replace(/[\t\r\n]+/g, ' ')

export const EVENTS_TSV_HEADER = 'date_time\tsource\tnode_id\tname\tseverity\tevent\tdetail\traw'

/** Every row, oldest first, whatever the view filters — like the stream export. */
export function eventsToTsv(rows: LogEvent[]): string {
  const body = [...rows]
    .sort((a, b) => a.id - b.id)
    .map((e) =>
      [fmtDateTime(e.t), e.source, e.nodeId, e.name, e.severity, e.event, e.detail, e.raw]
        .map(cell)
        .join('\t')
    )
  return [EVENTS_TSV_HEADER, ...body].join('\n') + '\n'
}
