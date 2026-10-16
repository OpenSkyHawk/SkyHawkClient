// The Gateway's own health (#94), pure (no Node/Electron deps). The Gateway is the SimGateway +
// PanelBridge board: the client's own link, never a cockpit node. Since firmware v3
// (OpenSkyhawk#344) it reports itself as the node-0 row of `_NODE_STATUS`; the cockpit model leaves
// that row out (node-rules), and this module carries it instead.
//
// Every alert is a flag the Gateway raised itself. The one client-side rule is "not responding": a
// roster request unanswered for GATEWAY_NO_ANSWER_MS while the port is open.
import type { LogEventInput } from './events'
import type { NodeStatus } from './nodes'

/** How long a roster request may go unanswered, with the port open, before the Gateway is "not responding". */
export const GATEWAY_NO_ANSWER_MS = 5000

/** What the Gateway reports about itself: its node-0 row, without the bits that change every poll. */
export interface GatewayRow {
  boff: boolean
  epvf: boolean
  tec: number
  rec: number
  /** Die temperature, whole °C; null until it has one. */
  dieTempC: number | null
  overheat: boolean
  degraded: boolean
  faultId: number
  /** From the fault dictionary (main fills it in); absent for an unknown id. */
  faultLabel?: string
  faultDesc?: string
}

/** Carried on `DeviceStatus` while the link is connected. */
export interface GatewayHealth {
  /** A roster request has gone unanswered for GATEWAY_NO_ANSWER_MS with the port open. */
  notResponding: boolean
  /** Its own row; absent until it first reports (and always, before firmware v3). */
  row?: GatewayRow
}

export function gatewayRow(n: NodeStatus): GatewayRow {
  const row: GatewayRow = {
    boff: n.boff,
    epvf: n.epvf,
    tec: n.tec,
    rec: n.rec,
    dieTempC: n.dieTempC,
    overheat: n.overheat,
    degraded: n.degraded,
    faultId: n.faultId
  }
  if (n.faultLabel) row.faultLabel = n.faultLabel
  if (n.faultDesc) row.faultDesc = n.faultDesc
  return row
}

function sameRow(a?: GatewayRow, b?: GatewayRow): boolean {
  if (!a || !b) return a === b
  return (Object.keys(a) as (keyof GatewayRow)[])
    .concat(Object.keys(b) as (keyof GatewayRow)[])
    .every((k) => a[k] === b[k])
}

export type GatewayProblemKind =
  | 'not-responding'
  | 'bus-off'
  | 'overheat'
  | 'error-passive'
  | 'fault'

export interface GatewayProblem {
  kind: GatewayProblemKind
  /** error: panel input can't reach DCS. warn: it reports a problem but still works. */
  severity: 'error' | 'warn'
}

/** A fault code, or DEGRADED without one. */
function hasFault(r: GatewayRow): boolean {
  return r.degraded || r.faultId !== 0
}

/** `Duplicate NODE_ID`, else `Fault 9`; `Degraded` when no code came with it. */
export function gatewayFaultLabel(r: GatewayRow): string {
  if (r.faultId === 0) return 'Degraded'
  return r.faultLabel ?? `Fault ${r.faultId}`
}

/** The worst thing it reports, or null when healthy (or nothing reported yet). */
export function gatewayProblem(h: GatewayHealth | undefined): GatewayProblem | null {
  if (!h) return null
  if (h.notResponding) return { kind: 'not-responding', severity: 'error' }
  const r = h.row
  if (!r) return null
  if (r.boff) return { kind: 'bus-off', severity: 'error' }
  if (r.overheat) return { kind: 'overheat', severity: 'warn' }
  if (r.epvf) return { kind: 'error-passive', severity: 'warn' }
  if (hasFault(r)) return { kind: 'fault', severity: 'warn' }
  return null
}

// ── event log ───────────────────────────────────────────────────────────────

const NAME = 'Gateway'

const temp = (r: GatewayRow): string | undefined =>
  r.dieTempC === null ? undefined : `${r.dieTempC} °C`

/**
 * Rows for what changed in its own report: a flag raised (warn, bus-off error) or cleared (info),
 * the same wording the node rows use. `prev` undefined = its first report since the port opened:
 * problems already present get their rows, a healthy report gets none.
 */
export function gatewayRowEvents(
  prev: GatewayRow | undefined,
  next: GatewayRow,
  raw: string,
  now: number
): LogEventInput[] {
  const out: LogEventInput[] = []
  const ev = (severity: LogEventInput['severity'], event: string, detail?: string): void => {
    out.push({ t: now, source: 'client', name: NAME, severity, event, detail, raw })
  }
  const flag = (
    on: boolean,
    was: boolean,
    label: string,
    severity: 'error' | 'warn',
    detail?: string
  ): void => {
    if (on && !was) ev(severity, label, detail)
    else if (!on && was) ev('info', `${label} cleared`)
  }
  flag(next.boff, prev?.boff ?? false, 'bus-off', 'error')
  flag(next.overheat, prev?.overheat ?? false, 'overheat', 'warn', temp(next))
  flag(next.epvf, prev?.epvf ?? false, 'error-passive', 'warn', `TEC ${next.tec}`)
  const fault = hasFault(next)
  const hadFault = prev ? hasFault(prev) : false
  if (fault && hadFault && prev!.faultId !== next.faultId) {
    ev('warn', 'degraded', gatewayFaultLabel(next))
  } else {
    flag(fault, hadFault, 'degraded', 'warn', gatewayFaultLabel(next))
  }
  return out
}

// ── the watch ───────────────────────────────────────────────────────────────

/**
 * Follows the Gateway for one open port: its own row, and whether it still answers roster
 * requests. Driven by the device link (asked / answered / tick); hands back log rows for what
 * changed, and says when the health worth pushing changed.
 */
export class GatewayWatch {
  /** The oldest roster request still unanswered. */
  private askedAt?: number
  private row?: GatewayRow
  private noAnswer = false
  private changed = true

  /** A port open or close: a different board, or the same one after an outage. */
  reset(): void {
    this.askedAt = undefined
    this.row = undefined
    this.noAnswer = false
    this.changed = true
  }

  /** A roster request went out. A later one doesn't restart the clock. */
  asked(now: number): void {
    this.askedAt ??= now
  }

  /** Any `_NODE_STATUS` / `_NODE_STATUS_END` line: it answers. */
  answered(raw: string, now: number): LogEventInput[] {
    this.askedAt = undefined
    if (!this.noAnswer) return []
    this.noAnswer = false
    this.changed = true
    return [
      { t: now, source: 'client', name: NAME, severity: 'info', event: 'responding again', raw }
    ]
  }

  /** Its own row (node 0) arrived. */
  report(n: NodeStatus, raw: string, now: number): LogEventInput[] {
    const next = gatewayRow(n)
    const prev = this.row
    if (sameRow(prev, next)) return []
    this.row = next
    this.changed = true
    return gatewayRowEvents(prev, next, raw, now)
  }

  /**
   * Called on the link's flush tick while the port is open. `paused`: a calibration exchange holds
   * the link, and a roster request going unanswered then is not news, so the clock starts over.
   * Clock only: "not responding" ends with an answer, never with a pause.
   */
  tick(now: number, paused = false): LogEventInput[] {
    if (paused) this.askedAt = undefined
    const silent = this.askedAt !== undefined && now - this.askedAt >= GATEWAY_NO_ANSWER_MS
    // Only an answer ends "not responding".
    if (this.noAnswer || !silent) return []
    this.noAnswer = true
    this.changed = true
    const secs = GATEWAY_NO_ANSWER_MS / 1000
    return [
      {
        t: now,
        source: 'client',
        name: NAME,
        severity: 'error',
        event: 'not responding',
        detail: `no answer for ${secs} s`,
        raw: `device: no roster reply for ${secs} s`
      }
    ]
  }

  health(): GatewayHealth {
    return this.row
      ? { notResponding: this.noAnswer, row: this.row }
      : { notResponding: this.noAnswer }
  }

  /** True once since the last call if the health changed. */
  takeChanged(): boolean {
    const c = this.changed
    this.changed = false
    return c
  }
}
