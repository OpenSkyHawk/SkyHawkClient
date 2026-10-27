// Node fault and flag text (pure, no Node/Electron deps): what a raised PDU rail or status flag is
// called in an event row and on the Cockpit, what it means, and the reading that goes with it — and
// the one order a node's own flags are named in, on the Cockpit and in the event log alike (X6/R8).
import type { EventSeverity } from '@shared/events'
import { amps, volts } from '@shared/format'
import { PDU_RAIL_FLAGS as RAIL_FLAG, PDU_STATUS_FLAGS as PDU_FLAG } from '@shared/firmware'
import type { NodeStatus, NodeView, PduRailPage, PduReadings } from '@shared/nodes'
import { STATUS_FLAGS, type StatusFlag } from '../events'
import { displayCurrentMa } from './node-telem'

// ── a node's own flags ──

/**
 * The order a node's own flags are named in, everywhere (X6/R8): bus-off, then the fault it reports
 * (degraded), overheat, error-passive. The Cockpit's tile, Attention, status boxes and Adopt
 * evidence and the event log's rows all read it from here.
 */
export const NODE_FLAG_ORDER: readonly StatusFlag[] = ['boff', 'degraded', 'overheat', 'epvf']

/** The status-flag vocabulary (label, severity) in NODE_FLAG_ORDER: what the event log walks. */
export const NODE_FLAGS = NODE_FLAG_ORDER.map((k) => STATUS_FLAGS[k])

/** The flags a node raised, in NODE_FLAG_ORDER. */
export function raisedNodeFlags(n: NodeStatus): StatusFlag[] {
  return NODE_FLAG_ORDER.filter((k) => n[k])
}

/**
 * The flags a node raised, in words (`bus-off`, the fault abbr or `unknown fault (N)`, `overheat`,
 * `error-passive`).
 */
export function nodeFlagWords(n: NodeStatus): string[] {
  return raisedNodeFlags(n).map((k) =>
    k === 'degraded' ? (n.faultAbbr ?? `unknown fault (${n.faultId})`) : STATUS_FLAGS[k].label
  )
}

const CHIP: Record<StatusFlag, string> = {
  boff: 'BUS-OFF',
  degraded: '',
  overheat: 'OVERHEAT',
  epvf: 'ERR-PASSIVE'
}

/** The flags a node raised, as the Cockpit's chip prints them (`BUS-OFF`, the fault tag, …). */
export function nodeFlagChips(n: NodeStatus): string[] {
  return raisedNodeFlags(n).map((k) => (k === 'degraded' ? nodeFaultTag(n) : CHIP[k]))
}

// ── PDU flags ──

/** Rail flag text, as the Cockpit prints it (`5V UNDER-V`). */
export const RAIL_FLAGS: [number, string][] = [
  [RAIL_FLAG.UNDER_V, 'UNDER-V'],
  [RAIL_FLAG.OVER_V, 'OVER-V'],
  [RAIL_FLAG.OVER_CURRENT, 'OVER-I'],
  [RAIL_FLAG.FUSE_OPEN, 'FUSE OPEN'],
  [RAIL_FLAG.SENSOR_FAULT, 'SENSOR FAULT']
]

/** UNCAL_* are calibration state, not alerts (as on the Cockpit), so they are info. */
export const PDU_STATUS_FLAGS: [number, string, EventSeverity][] = [
  [PDU_FLAG.TEMP_CRIT, 'TEMP CRIT', 'warn'],
  [PDU_FLAG.TEMP_WARN, 'TEMP WARN', 'warn'],
  [PDU_FLAG.NTC_FAULT, 'NTC FAULT', 'warn'],
  [PDU_FLAG.UNCAL_VDDA, 'UNCAL VDDA', 'info'],
  [PDU_FLAG.UNCAL_ZERO, 'UNCAL ZERO', 'info']
]

export const TEMP_FLAGS = PDU_FLAG.TEMP_CRIT | PDU_FLAG.TEMP_WARN

/** The reading that goes with a raised rail flag: the window minimum for under-voltage. */
export function railReading(bit: number, p: PduRailPage): string {
  if (bit === RAIL_FLAG.UNDER_V) return volts(p.vMinMv)
  if (bit === RAIL_FLAG.OVER_CURRENT) return amps(displayCurrentMa(p.iAvgMa))
  return volts(p.vAvgMv)
}

/**
 * Short degraded-badge tag, as a flag prints: the fault abbr, or `UNKNOWN FAULT (N)` for a code this
 * client has no label for (#183).
 */
export function nodeFaultTag(n: NodeStatus): string {
  return n.faultAbbr ?? `UNKNOWN FAULT (${n.faultId})`
}

// ── the Cockpit's flag text (moved from the renderer, R3.2): the same tables as the log's ──

/** Status flags that are alerts. UNCAL_VDDA / UNCAL_ZERO are calibration state (info), not alerts. */
const STATUS_ALERTS = PDU_STATUS_FLAGS.filter(([, , severity]) => severity !== 'info')

/** The alert flags a PDU raises on its fresh pages, e.g. `5V UNDER-V`. Empty = healthy. */
export function pduAlertFlags(r: PduReadings): string[] {
  const out: string[] = []
  const rail = (label: string, p?: PduRailPage) => {
    for (const [bit, text] of RAIL_FLAGS) if (p && p.flags & bit) out.push(`${label} ${text}`)
  }
  rail('12V', r.rail12V)
  rail('5V', r.rail5V)
  for (const [bit, text] of STATUS_ALERTS) if (r.status && r.status.flags & bit) out.push(text)
  return out
}

/** Flag meanings as NodeStatus.h states them. */
const RAIL_MEANING: [number, string][] = [
  [RAIL_FLAG.UNDER_V, 'below its under-voltage threshold'],
  [RAIL_FLAG.OVER_V, 'above its over-voltage threshold'],
  [RAIL_FLAG.OVER_CURRENT, 'drawing sustained current above the over-current threshold'],
  [RAIL_FLAG.FUSE_OPEN, 'reading ~0 V while the node is powered — fuse blown'],
  [RAIL_FLAG.SENSOR_FAULT, 'reading implausibly on its voltage or current channel']
]
const STATUS_MEANING: [number, string][] = [
  [PDU_FLAG.TEMP_CRIT, 'board temperature at the critical threshold'],
  [PDU_FLAG.TEMP_WARN, 'board temperature at the warning threshold'],
  [PDU_FLAG.NTC_FAULT, 'NTC channel open or shorted']
]

/** What each raised PDU flag means, in plain words. */
export function pduFlagMeanings(v: NodeView): string[] {
  const out: string[] = []
  const rail = (label: string, p?: PduRailPage) => {
    for (const [bit, m] of RAIL_MEANING)
      if (p && p.flags & bit) out.push(`the ${label} rail is ${m}`)
  }
  rail('12 V', v.readings.rail12V)
  rail('5 V', v.readings.rail5V)
  const s = v.readings.status
  for (const [bit, m] of STATUS_MEANING) if (s && s.flags & bit) out.push(m)
  return out
}
