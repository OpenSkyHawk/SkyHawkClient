// Cockpit side panels (#76): the pure decisions behind the node and PDU panels — which actions a
// node offers, what its fault box says, the rows each panel shows and the mapping patch Save
// sends. Every value is something a board reported or the client computed, labelled as such.
import type { MappingPatch } from '@shared/node-mapping'
import type { NodeModelEntry } from '@shared/node-rules'
import { PDU_FLAG, RAIL_FLAG, displayCurrentMa, type PduRailPage } from '@shared/node-telem'
import { nodeFaultTag } from '@shared/nodes'
import { pduAlertFlags, type NodeView } from './cockpit'
import { fmtUptime } from './store'

const DASH = '—'

// ── node actions ────────────────────────────────────────────────────────────

/** reset / forget = forgetNode, hide = hideNode, ignore = ignoreNode. */
export type NodeAction = 'reset' | 'forget' | 'hide' | 'ignore'

/**
 * The node panel's footer, besides Save. A registry node resets to its NODE_IDS defaults; an
 * adopted node is forgotten (it shows as new again), since it has no defaults; either can be
 * hidden while it is offline (a replaced or removed board). A new node can only be ignored.
 */
export function nodeActions(e: NodeModelEntry): NodeAction[] {
  if (e.source === 'new') return ['ignore']
  const hide: NodeAction[] = e.availability === 'offline' ? ['hide'] : []
  return [e.source === 'adopted' ? 'forget' : 'reset', ...hide]
}

// ── fault box ───────────────────────────────────────────────────────────────

export interface FaultBox {
  tone: 'warn' | 'err' | 'new'
  title: string
  text: string
}

/** The box at the top of the node panel's Status tab; null when there is nothing to explain. */
export function nodeFaultBox(v: NodeView): FaultBox | null {
  const e = v.entry
  const st = e.status
  if (e.source === 'new') {
    return {
      tone: 'new',
      title: 'Not in registry',
      text: 'this NODE_ID is not in the bundled NODE_IDS.md. Name it and place it on the map.'
    }
  }
  if (e.availability === 'unknown') {
    return {
      tone: 'new',
      title: 'No status yet',
      text: 'no complete roster has arrived since the link opened, and this node has not reported.'
    }
  }
  if (e.availability === 'offline') {
    return {
      tone: 'err',
      title: 'Offline',
      text: 'missing from the PanelBridge roster — no heartbeat within its timeout.'
    }
  }
  if (!st) return null
  if (st.boff) {
    return {
      tone: 'err',
      title: 'Bus-off',
      text: 'its CAN controller stopped transmitting after too many errors. Reported by the node.'
    }
  }
  if (st.degraded) {
    return {
      tone: 'warn',
      title: st.faultLabel ?? nodeFaultTag(st),
      text: st.faultDesc || 'reported by the node; this client has no description for this code.'
    }
  }
  if (st.overheat) {
    return { tone: 'warn', title: 'Overheat', text: 'the node raised its own temperature trip.' }
  }
  if (st.epvf) {
    return {
      tone: 'warn',
      title: 'Error-passive',
      text: 'its CAN error counters are high; it still communicates but can only signal errors passively.'
    }
  }
  return null
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

/**
 * The boxes at the top of the PDU panel, stacked. Offline says it all on its own. Otherwise the
 * PDU's own node fault (the same as any node's) comes first, then its rail / status flags, then
 * "no readings": each is a separate thing the board told us, so none hides another.
 */
export function pduFaultBoxes(v: NodeView, outage: boolean): FaultBox[] {
  const e = v.entry
  if (e.availability === 'offline') {
    return [
      {
        tone: 'err',
        title: 'Offline',
        text:
          'no status or readings from this PDU.' +
          (outage
            ? ' Its nodes dropped at the same time — a blown 5 V fuse at the PDU looks like this.'
            : '')
      }
    ]
  }
  const out: FaultBox[] = []
  const node = nodeFaultBox(v)
  if (node) out.push(node)
  const flags = pduAlertFlags(v.readings)
  if (flags.length) {
    const said = pduFlagMeanings(v).join('; ')
    out.push({ tone: 'warn', title: flags.join(' · '), text: `${said}. Raised by the board.` })
  }
  if (v.noReadings) {
    out.push({
      tone: 'new',
      title: 'No readings received',
      text:
        'the PDU is online but no telemetry has arrived.' +
        (e.everHadReadings
          ? ''
          : ' If it never had readings, the PanelBridge firmware may be too old to forward PDU telemetry.')
    })
  }
  return out
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface Row {
  k: string
  v: string
}

/** "Reported by the node" on the Status tab. An offline node keeps what it last said. */
export function nodeStatusRows(v: NodeView): Row[] {
  const st = v.entry.status
  const state =
    v.health.state === 'unknown'
      ? 'no status yet'
      : v.entry.availability === 'offline'
        ? 'offline'
        : st?.boff
          ? 'bus-off'
          : v.health.state === 'warn'
            ? st?.degraded
              ? 'degraded'
              : 'warning'
            : 'healthy'
  // Online: what it reports now. Offline or before the roster: only the last rx count means much.
  const live = st && v.entry.availability === 'online' ? st : undefined
  return [
    { k: 'Status', v: state },
    { k: 'Uptime', v: live ? fmtUptime(live.uptimeSec) : DASH },
    {
      k: 'CAN frames rx',
      v: st ? `${st.rxCount.toLocaleString('en-US')}${live ? '' : ' (last seen)'}` : DASH
    },
    { k: 'CAN TEC / REC', v: live ? `${live.tec} / ${live.rec}` : DASH },
    {
      k: 'CAN state',
      v: live ? (live.boff ? 'bus-off' : live.epvf ? 'error-passive' : 'error-active') : DASH
    },
    { k: 'MCU temp', v: live && live.dieTempC !== null ? `${live.dieTempC} °C` : DASH }
  ]
}

export interface RailRow {
  rail: '12 V' | '5 V'
  avg: string
  min: string
  amps: string
  peak: string
  /** Client-computed V × A; '' when there is nothing to compute. */
  watts: string
  flagged: boolean
}

/** "Rails · live" on the PDU panel: per rail avg V / min V / A / peak A over the 3 s window. */
export function pduRailRows(v: NodeView): RailRow[] {
  const show = v.entry.availability === 'online' && !v.noReadings
  const s = show ? v.readings.status : undefined
  const row = (rail: RailRow['rail'], p: PduRailPage | undefined, peakMa?: number): RailRow => {
    if (!show || !p) {
      return { rail, avg: DASH, min: DASH, amps: DASH, peak: DASH, watts: '', flagged: false }
    }
    const amps = displayCurrentMa(p.iAvgMa) / 1000
    return {
      rail,
      avg: (p.vAvgMv / 1000).toFixed(2),
      min: (p.vMinMv / 1000).toFixed(2),
      amps: amps.toFixed(2),
      peak: peakMa !== undefined ? (peakMa / 1000).toFixed(2) : DASH,
      watts: ((p.vAvgMv / 1000) * amps).toFixed(1),
      flagged: p.flags !== 0
    }
  }
  return [
    row('12 V', show ? v.readings.rail12V : undefined, s?.i12PeakMa),
    row('5 V', show ? v.readings.rail5V : undefined, s?.i5PeakMa)
  ]
}

/** "Board status" on the PDU panel. */
export function pduBoardRows(v: NodeView): Row[] {
  const online = v.entry.availability === 'online'
  const s = online && !v.noReadings ? v.readings.status : undefined
  const st = online ? v.entry.status : undefined
  const ntc = !s
    ? DASH
    : s.flags & PDU_FLAG.NTC_FAULT
      ? 'fault — NTC open or shorted'
      : s.ntcTempC === null
        ? 'unavailable'
        : `${s.ntcTempC.toFixed(1)} °C`
  const cal = (bit: number, missing: string) => (!s ? DASH : s.flags & bit ? missing : 'done')
  return [
    { k: 'Connector temp (NTC)', v: ntc },
    { k: 'MCU temp', v: st && st.dieTempC !== null ? `${st.dieTempC} °C` : DASH },
    {
      k: 'VDDA calibration',
      v: cal(PDU_FLAG.UNCAL_VDDA, 'not done — readings assume a nominal 3.3 V')
    },
    { k: 'Zero calibration', v: cal(PDU_FLAG.UNCAL_ZERO, 'not done') }
  ]
}

// ── placement (Settings tab) ────────────────────────────────────────────────

/** NODE_IDS.md console names, as the mapping stores them. */
export const CONSOLE_OPTIONS = [
  { value: 'Left', label: 'Left console' },
  { value: 'Center', label: 'Instrument panel' },
  { value: 'Right', label: 'Right console' }
] as const

export function consoleLabel(console: string | null): string {
  return CONSOLE_OPTIONS.find((c) => c.value === console)?.label ?? console ?? DASH
}

/**
 * The PDUs a panel on `console` can be fed by: the placed PDUs on that console (a PDU on the left
 * console cannot power the instrument panel). None is always offered by the caller. A stored zone
 * on another console (set before this rule, or the PDU moved) stays listed, marked, until changed.
 */
export function powerZoneOptions(
  views: NodeView[],
  console: string,
  current: number | null
): { value: number; label: string }[] {
  const pdus = views.filter((v) => v.entry.kind === 'pdu' && v.entry.source !== 'new')
  const out = pdus
    .filter((v) => v.entry.console === console)
    .map((v) => ({ value: v.entry.nodeId, label: v.entry.name }))
  const stray = current === null ? undefined : pdus.find((v) => v.entry.nodeId === current)
  if (stray && stray.entry.console !== console) {
    out.push({ value: stray.entry.nodeId, label: `${stray.entry.name} (other console)` })
  }
  return out
}

/** Picking a console picks its first PDU (none when it has no PDU), as the board does. */
export function firstPduOn(views: NodeView[], console: string): number | null {
  const pdu = views.find(
    (v) => v.entry.kind === 'pdu' && v.entry.source !== 'new' && v.entry.console === console
  )
  return pdu ? pdu.entry.nodeId : null
}

export interface PlacementForm {
  name: string
  console: string
  pduId: number | null
}

/** Only what changed, so Save writes nothing when nothing did. */
export function mappingPatch(e: NodeModelEntry, f: PlacementForm): MappingPatch {
  const p: MappingPatch = {}
  if (f.name.trim() !== e.name) p.name = f.name.trim()
  if (e.kind === 'panel') {
    if (f.console !== (e.console ?? '')) p.console = f.console
    if (f.pduId !== e.pduId) p.pduId = f.pduId
  }
  return p
}
