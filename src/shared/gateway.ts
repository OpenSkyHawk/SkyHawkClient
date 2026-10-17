// The Gateway's own health (#94), pure (no Node/Electron deps). The Gateway is the SimGateway +
// PanelBridge board: the client's own link, never a cockpit node. Since firmware v3
// (OpenSkyhawk#344) it reports itself as the node-0 row of `_NODE_STATUS`; the cockpit model leaves
// that row out (node-rules), and this module carries it instead.
//
// The one owner of the Gateway's health: `gatewayStatus` decides severity, label, note and alert,
// main computes it (GatewayWatch) and sends it on `device:status`, and every surface — pill,
// popover, Overview alert, Cockpit Attention, event log — only reads it. Every alert is a flag the
// Gateway raised itself; the one client-side rule is "not responding": once it has answered since
// the port opened, a roster request unanswered for GATEWAY_NO_ANSWER_MS while the port is open.
import { faultLabel, STATUS_FLAGS, type LogEventInput, type StatusFlag } from './events'
import { NODE_FAULT_CODES } from './firmware'
import type { NodeStatus } from './nodes'

/** How long a roster request may go unanswered, with the port open, before the Gateway is "not responding". */
export const GATEWAY_NO_ANSWER_MS = 5000

const SECS = GATEWAY_NO_ANSWER_MS / 1000

export type GatewayKind =
  | 'ok'
  | 'not-responding'
  | 'bus-off'
  | 'overheat'
  | 'error-passive'
  | 'fault'

/** What the client shows about the Gateway. Carried on `DeviceStatus` while connected. */
export interface GatewayStatus {
  /** err: panel input can't reach DCS. warn: it reports a problem but still works. */
  severity: 'ok' | 'warn' | 'err'
  /** The worst thing it reports; only that one is shown. */
  kind: GatewayKind
  /** `OK · 42 °C`, `Overheat · 78 °C`, `Error-passive`, `Duplicate NODE_ID`, `Bus-off`, `Not responding`. */
  label: string
  /** One line on what it means and what to do; absent when healthy. */
  note?: string
  /** Serious faults only (severity err): the Overview alert. */
  alert?: { head: string; text: string }
}

type Flag = (typeof STATUS_FLAGS)[number]
const flag = (key: StatusFlag): Flag => STATUS_FLAGS.find((f) => f.key === key)!

/** `bus-off` → `Bus-off`: the node rows' flag names, as a title. */
const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

/**
 * Client wording for the faults a Gateway reports about itself, keyed by NODE_FAULT_CODES name.
 * Others show their label alone: the dictionary's descriptions read like firmware notes.
 */
const FAULT_NOTE: Partial<Record<string, string>> = {
  HOST_LINK_LOST:
    'It reports losing its serial link to this computer. If it keeps happening, check the USB cable.',
  DUPLICATE_NODE_ID:
    'Another board on the bus uses NODE_ID 0, the Gateway’s own. Reflash that board with a different NODE_ID.'
}

/** The client note for a fault code, looked up by the code's firmware name. */
const faultNote = (faultId: number): string | undefined => {
  const name = NODE_FAULT_CODES[faultId]?.name
  return name === undefined ? undefined : FAULT_NOTE[name]
}

const withTemp = (label: string, n: NodeStatus): string =>
  n.dieTempC === null ? label : `${label} · ${n.dieTempC} °C`

/**
 * The Gateway's health from its own row (node 0) and the roster timeout. undefined = nothing to
 * say yet: nothing is judged before it reports. Bus-off and error-passive come from its CAN
 * controller and are live in every row; overheat, the fault code and the temperature come from its
 * own health frame (HEALTH_0, ~1/s; none with NODE_HEALTH_TELEM=0), which a row has only once its
 * kind is set. Worst first: not responding, bus-off, overheat, error-passive, a fault code.
 */
export function gatewayStatus(
  row: NodeStatus | undefined,
  notResponding: boolean
): GatewayStatus | undefined {
  if (notResponding) {
    return {
      severity: 'err',
      kind: 'not-responding',
      label: 'Not responding',
      note: `No answer for ${SECS} s while the port is open. Unplug its USB cable and plug it back in.`,
      alert: {
        head: 'Gateway not responding',
        text: `no answer for ${SECS} s while its port is open. Unplug its USB cable and plug it back in.`
      }
    }
  }
  if (!row) return undefined
  const health = row.nodeKind !== 0 // its health frame has arrived
  const sev = (f: Flag) => (f.severity === 'error' ? 'err' : 'warn') as 'err' | 'warn'
  if (row.boff) {
    const f = flag('boff')
    return {
      severity: sev(f),
      kind: 'bus-off',
      label: title(f.label),
      note: 'It stopped transmitting after too many CAN errors and recovers by itself in about 40 s.',
      alert: {
        head: 'The Gateway can’t reach your panels',
        text: 'its cockpit (CAN) side went bus-off, so panel inputs aren’t reaching DCS. It recovers by itself in about 40 s; if it keeps happening, check the CAN cabling and termination.'
      }
    }
  }
  if (health && row.overheat) {
    const f = flag('overheat')
    return {
      severity: sev(f),
      kind: 'overheat',
      label: withTemp(title(f.label), row),
      note: 'The Gateway raised its own temperature trip. Check the airflow around it.'
    }
  }
  if (row.epvf) {
    const f = flag('epvf')
    return {
      severity: sev(f),
      kind: 'error-passive',
      label: title(f.label),
      note: 'Its CAN error count is high, so it may lose an occasional panel input on the way to DCS. Usually cabling or termination; it also happens when no other board is on the bus.'
    }
  }
  if (health && (row.degraded || row.faultId !== 0)) {
    return {
      severity: sev(flag('degraded')),
      kind: 'fault',
      label: faultLabel(row),
      note: faultNote(row.faultId)
    }
  }
  if (!health) return undefined
  return { severity: 'ok', kind: 'ok', label: withTemp('OK', row) }
}

// ── event log ───────────────────────────────────────────────────────────────

const RANK: Record<GatewayKind, number> = {
  'not-responding': 5,
  'bus-off': 4,
  overheat: 3,
  'error-passive': 2,
  fault: 1,
  ok: 0
}

/** The node rows' wording for each kind: event name and detail. */
function said(s: GatewayStatus, row: NodeStatus | undefined): { event: string; detail?: string } {
  switch (s.kind) {
    case 'not-responding':
      return { event: 'not responding', detail: `no answer for ${SECS} s` }
    case 'bus-off':
      return { event: flag('boff').label }
    case 'overheat':
      return { event: flag('overheat').label }
    case 'error-passive':
      return { event: flag('epvf').label, detail: row && `TEC ${row.tec} · REC ${row.rec}` }
    default:
      return { event: flag('degraded').label, detail: s.label }
  }
}

/** Same problem, so no row: the kind, and for a fault its code (a new code is news). */
const sameProblem = (a?: GatewayStatus, b?: GatewayStatus): boolean =>
  (a?.kind ?? 'ok') === (b?.kind ?? 'ok') && (a?.kind !== 'fault' || a.label === b?.label)

/**
 * Rows for a change in what the Gateway shows (worst problem only, as every surface shows it): the
 * new problem raised (error / warn), or the old one cleared (info) — `responding again` after not
 * responding. A milder problem taking over says the worse one cleared, then names itself.
 */
export function gatewayEvents(
  prev: GatewayStatus | undefined,
  next: GatewayStatus | undefined,
  row: NodeStatus | undefined,
  raw: string,
  now: number
): LogEventInput[] {
  if (sameProblem(prev, next)) return []
  const out: LogEventInput[] = []
  const ev = (severity: LogEventInput['severity'], event: string, detail?: string): void => {
    out.push({ t: now, source: 'client', name: 'Gateway', severity, event, detail, raw })
  }
  const was = prev && prev.kind !== 'ok' ? prev : undefined
  const is = next && next.kind !== 'ok' ? next : undefined
  if (was && (!is || RANK[is.kind] < RANK[was.kind] || was.kind === is.kind)) {
    if (was.kind === 'not-responding') ev('info', 'responding again')
    else if (!is || is.kind !== was.kind) ev('info', `${said(was, row).event} cleared`)
  }
  if (is) {
    const s = said(is, row)
    ev(is.severity === 'err' ? 'error' : 'warn', s.event, s.detail)
  }
  return out
}

// ── the watch ───────────────────────────────────────────────────────────────

/**
 * Follows the Gateway for one open port: its own row, and whether it still answers roster
 * requests. Driven by the device link (asked / answered / report / tick); hands back log rows for
 * what changed, and says when the status worth pushing changed.
 */
export class GatewayWatch {
  /** The oldest roster request still unanswered. */
  private askedAt?: number
  private row?: NodeStatus
  private noAnswer = false
  /**
   * It has answered since the port opened. Only then can it stop answering: a Gateway that never
   * answers (built without node status, PANELBRIDGE_NODE_STATUS off) is not "not responding".
   */
  private answeredOnce = false
  private current?: GatewayStatus
  private changed = true

  /** A port open or close: a different board, or the same one after an outage. */
  reset(): void {
    this.askedAt = undefined
    this.row = undefined
    this.noAnswer = false
    this.answeredOnce = false
    this.current = undefined
    this.changed = true
  }

  /** A roster request went out. A later one doesn't restart the clock. */
  asked(now: number): void {
    this.askedAt ??= now
  }

  /** Any `_NODE_STATUS` / `_NODE_STATUS_END` line: it answers. */
  answered(raw: string, now: number): LogEventInput[] {
    this.askedAt = undefined
    this.answeredOnce = true
    if (!this.noAnswer) return []
    this.noAnswer = false
    return this.update(raw, now)
  }

  /** Its own row (node 0) arrived, fault labels filled in. */
  report(n: NodeStatus, raw: string, now: number): LogEventInput[] {
    this.row = n
    return this.update(raw, now)
  }

  /**
   * Called on the link's flush tick while the port is open. `paused`: a calibration exchange holds
   * the link, and a roster request going unanswered then is not news, so the clock starts over.
   * Clock only: "not responding" ends with an answer, never with a pause. Armed by its first
   * answer since the port opened.
   */
  tick(now: number, paused = false): LogEventInput[] {
    if (paused) this.askedAt = undefined
    const silent =
      this.answeredOnce && this.askedAt !== undefined && now - this.askedAt >= GATEWAY_NO_ANSWER_MS
    if (this.noAnswer || !silent) return []
    this.noAnswer = true
    return this.update(`device: no roster reply for ${SECS} s`, now)
  }

  private update(raw: string, now: number): LogEventInput[] {
    const prev = this.current
    const next = gatewayStatus(this.row, this.noAnswer)
    if (JSON.stringify(prev) === JSON.stringify(next)) return []
    this.current = next
    this.changed = true
    return gatewayEvents(prev, next, this.row, raw, now)
  }

  status(): GatewayStatus | undefined {
    return this.current
  }

  /** True once since the last call if the status changed. */
  takeChanged(): boolean {
    const c = this.changed
    this.changed = false
    return c
  }
}
