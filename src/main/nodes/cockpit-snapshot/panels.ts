// The Cockpit's side panels (moved from the renderer, R3.2;
// one design for every board since #93): which actions a board offers, what its fault boxes say,
// the rows each panel shows, which PDU feeds a panel group and which boards a PDU feeds, and the
// power zones a panel can be given. Every value is something a board reported or the client
// computed, labelled as such.
import { DASH, fmtUptime, lastSeenLabel } from '@shared/format'
import {
  CONSOLE_OPTIONS,
  type BoardAction,
  type BoardActions,
  type BoardPanel,
  type FaultBox,
  type FedBoard,
  type NodeModelEntry,
  type NodeStatus,
  type NodeView,
  type PduOutage,
  type PduRailPage,
  type PowerZone,
  type RailRow,
  type Row,
  type ZoneChoices
} from '@shared/nodes'
import { PDU_STATUS_FLAGS as PDU_FLAG } from '@shared/firmware'
import type { StatusFlag } from '../../events'
import { nodeFaultTag, pduAlertFlags, pduFlagMeanings, raisedNodeFlags } from '../faults'
import { newReason } from '../node-model'
import { displayCurrentMa } from '../node-telem'
import { canForget, canHide, type OfflineGate } from '../offline-actions'
import { fedBy, zoneLabel } from '../power-zone'
import type { Members } from './members'

// ── board actions ───────────────────────────────────────────────────────────

/**
 * Same rules for a panel group and a PDU (#93). Hide and Forget wait until the board is offline,
 * by the one rule main refuses them by (offline-actions.ts canHide / canForget) over the one
 * availability (node-model.ts availabilityOf: a PDU's pages weighed against the roster), so the
 * footer and main always agree.
 * `fed` = boards in your cockpit this PDU feeds, hidden ones included (power-zone.ts fedBy, X7):
 * Forget unlinks them all; Hide keeps the links.
 */
export function boardActions(e: NodeModelEntry, fed = 0): BoardActions {
  const signals = { availability: e.availability }
  const off = (gate: OfflineGate, tip: string): BoardAction =>
    gate.ok ? { disabled: false, tip } : { disabled: true, tip: gate.note }
  const forget = canForget(signals)
  const a: BoardActions = {
    forget: off(
      forget,
      e.kind === 'pdu'
        ? 'Remove it from your cockpit; its boards lose the link'
        : 'Remove it from your cockpit and the saved mapping'
    ),
    hide: off(
      canHide(signals),
      e.kind === 'pdu'
        ? 'Hide until it reports again; its boards keep the link'
        : 'Hide until it reports again'
    ),
    note: forget.ok ? '' : forget.note
  }
  if (e.source === 'registry') {
    a.reset = e.differs
      ? {
          disabled: false,
          tip:
            e.kind === 'pdu'
              ? 'Restore the name and console from NODE_IDS.md'
              : 'Restore the name, console and power zone from NODE_IDS.md'
        }
      : { disabled: true, tip: 'Already at the NODE_IDS.md defaults' }
  }
  if (!forget.ok) return a
  if (e.kind === 'pdu') {
    const boards = fed
      ? `Its ${fed} board${fed === 1 ? '' : 's'} move to No power zone and keep no link to it, even if it comes back. `
      : ''
    a.note = `Forget removes this PDU from your cockpit. ${boards}Hide keeps the links: they return under it when it reports.`
  } else {
    const back =
      e.source === 'adopted'
        ? 'it shows as new'
        : 'it waits in New on the bus, pre-filled from NODE_IDS.md'
    a.note = `Forget removes it from your cockpit and the saved mapping; if it reports again ${back}. Hide takes it off the Cockpit until it reports again.`
  }
  return a
}

/** The box for a board remembered from an earlier session but not listed since the link opened. */
function notSeenBox(e: NodeModelEntry): FaultBox {
  const when = e.lastSeenAt !== undefined ? `last seen ${lastSeenLabel(e.lastSeenAt)}. ` : ''
  return {
    tone: 'err',
    title: 'Not seen this session',
    text: `${when}It’s remembered from an earlier session. Forget or Hide it if it’s no longer part of your cockpit.`
  }
}

// ── fault box ───────────────────────────────────────────────────────────────

/**
 * The boxes at the top of the node panel's Status tab, stacked; empty when there is nothing to
 * explain. New, no-status-yet and offline each stand alone. Otherwise every flag the node raised
 * gets its own box — bus-off, then degraded (the fault table's label), overheat, error-passive,
 * the one order (faults.ts NODE_FLAG_ORDER) — so a second fault never hides behind the first.
 */
export function nodeFaultBoxes(v: NodeView): FaultBox[] {
  const e = v.entry
  const st = e.status
  if (e.source === 'new') {
    // Where it comes from, worded once (X8, node-model.ts newReason).
    const reason = newReason(e)
    return [
      {
        tone: 'new',
        title: reason.charAt(0).toUpperCase() + reason.slice(1),
        text: e.registry
          ? 'this NODE_ID is in the bundled NODE_IDS.md and not added to your cockpit yet.'
          : 'this NODE_ID is not in the bundled NODE_IDS.md. Name it and place it on the map.'
      }
    ]
  }
  if (e.availability === 'unknown') {
    return [
      {
        tone: 'new',
        title: 'No status yet',
        text: 'no complete roster has arrived since the link opened, and this node has not reported.'
      }
    ]
  }
  if (e.notSeen) return [notSeenBox(e)]
  if (e.availability === 'offline') {
    return [
      {
        tone: 'err',
        title: 'Offline',
        text: 'missing from the Gateway roster — no heartbeat within its timeout.'
      }
    ]
  }
  if (!st) return []
  return raisedNodeFlags(st).map((k) => FLAG_BOX[k](st))
}

/** Each flag's box, as nodeFaultBoxes stacks them (in faults.ts NODE_FLAG_ORDER). */
const FLAG_BOX: Record<StatusFlag, (st: NodeStatus) => FaultBox> = {
  boff: () => ({
    tone: 'err',
    title: 'Bus-off',
    text: 'its CAN controller stopped transmitting after too many errors. Reported by the node.'
  }),
  degraded: (st) => ({
    tone: 'warn',
    title: st.faultLabel ?? nodeFaultTag(st),
    text: st.faultDesc || 'reported by the node; this client has no description for this code.'
  }),
  overheat: () => ({
    tone: 'warn',
    title: 'Overheat',
    text: 'the node raised its own temperature trip.'
  }),
  epvf: () => ({
    tone: 'warn',
    title: 'Error-passive',
    text: 'its CAN error counters are high; it still communicates but can only signal errors passively.'
  })
}

/**
 * The boxes at the top of the PDU panel, stacked. Offline says it all on its own. Otherwise the
 * PDU's own node faults (the same as any node's) come first, then its rail / status flags, then
 * "no readings": each is a separate thing the board told us, so none hides another.
 */
export function pduFaultBoxes(v: NodeView, outage: boolean): FaultBox[] {
  const e = v.entry
  if (e.notSeen) return [notSeenBox(e)]
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
  const out: FaultBox[] = nodeFaultBoxes(v)
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
          : ' If it never had readings, the Gateway firmware may be too old to forward PDU telemetry.')
    })
  }
  return out
}

// ── rows ────────────────────────────────────────────────────────────────────

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
      v: live ? (live.boff ? 'bus-off' : live.epvf ? 'error-passive' : 'OK') : DASH
    },
    { k: 'MCU temp', v: live && live.dieTempC !== null ? `${live.dieTempC} °C` : DASH }
  ]
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

// ── power zones ─────────────────────────────────────────────────────────────

/**
 * The PDUs a panel on `console` can be fed by: the PDUs in your cockpit on that console, hidden ones
 * included and labelled so (D7: only a PDU in your cockpit can be a zone) — a PDU on the left
 * console cannot power the instrument panel. None is always offered by the caller. A stored zone on
 * another console (set before this rule, or the PDU moved) stays listed, marked, until changed.
 */
export function powerZoneOptions(
  members: Members,
  console: string,
  current: number | null
): { value: number; label: string }[] {
  const out = members.pdus
    .filter((p) => p.console === console)
    .map((p) => ({ value: p.nodeId, label: zoneLabel(p.name, p.hidden) }))
  const stray = current === null ? undefined : members.pdus.find((p) => p.nodeId === current)
  if (stray && stray.console !== console) {
    out.push({ value: stray.nodeId, label: zoneLabel(stray.name, stray.hidden, true) })
  }
  return out
}

/**
 * Every Power zone list the forms can ask for — the panel's Settings tab and the Adopt form both
 * read these: for each console a form can hold (the three NODE_IDS.md consoles, none yet, and any
 * console a board or its NODE_IDS.md row names) with no zone, and with each PDU in your cockpit
 * (hidden ones included) as the stored zone. Changing the console clears the zone in both (N9).
 */
export function zoneChoices(views: NodeView[], members: Members): ZoneChoices {
  const consoles = new Set<string>(['', ...CONSOLE_OPTIONS.map((c) => c.value)])
  for (const v of views) {
    if (v.entry.console !== null) consoles.add(v.entry.console)
    if (v.entry.registry) consoles.add(v.entry.registry.console)
  }
  for (const m of members.all) if (m.hidden) consoles.add(m.console)
  const out: ZoneChoices = { options: {} }
  for (const c of consoles) {
    const byZone: Record<string, { value: number; label: string }[]> = {
      '': powerZoneOptions(members, c, null)
    }
    for (const p of members.pdus) byZone[p.nodeId] = powerZoneOptions(members, c, p.nodeId)
    out.options[c] = byZone
  }
  return out
}

// ── the panels ──────────────────────────────────────────────────────────────

/** A fed board's state in the Feeds list: its flag, else online / no status yet. */
function feedState(v: NodeView): string {
  const e = v.entry
  if (e.notSeen) return 'not seen this session'
  if (v.health.flag) return v.health.flag
  return v.health.state === 'unknown' ? 'no status yet' : 'online'
}

/**
 * The boards a PDU feeds, as its Feeds tab lists them: every board in your cockpit whose zone it is
 * (power-zone.ts fedBy), hidden ones included — what Forget unlinks (X7).
 */
function fedBoards(members: Members, views: NodeView[], pduId: number): FedBoard[] {
  const byId = new Map(views.map((v) => [v.entry.nodeId, v]))
  return fedBy(members.all, pduId).map((m) => {
    const v = byId.get(m.nodeId)
    return {
      nodeId: m.nodeId,
      name: m.name,
      detail: m.hidden || !v ? 'hidden until it reports again' : feedState(v),
      hidden: m.hidden
    }
  })
}

/**
 * The side panel of every board in your cockpit on the plan. A board outside your cockpit has none:
 * clicking it opens the Adopt dialog (D6, members.ts boardOpens — the same membership). A panel
 * group shows its resolved power zone (D7: `zones`, one per board). A PDU feeds the boards in your
 * cockpit whose zone it is, hidden ones included; that count is what Forget says it unlinks (X7: an
 * outage counts only the ones that could have dropped with it, pduOutages).
 */
export function boardPanels(
  views: NodeView[],
  outages: PduOutage[],
  members: Members,
  zones: ReadonlyMap<number, PowerZone>
): Record<number, BoardPanel> {
  const out: Record<number, BoardPanel> = {}
  for (const v of views) {
    const e = v.entry
    if (!members.get(e.nodeId)) continue
    let p: BoardPanel
    if (e.kind === 'pdu') {
      const feeds = fedBoards(members, views, e.nodeId)
      p = {
        faults: pduFaultBoxes(
          v,
          outages.some((o) => o.pduId === e.nodeId)
        ),
        actions: boardActions(e, feeds.length),
        rails: pduRailRows(v),
        board: pduBoardRows(v),
        feeds,
        sharedWith: views
          .filter(
            (o) =>
              o.entry.kind === 'pdu' &&
              o.entry.source !== 'new' &&
              o.entry.console === e.console &&
              o.entry.nodeId !== e.nodeId
          )
          .map((o) => o.entry.name)
      }
    } else {
      p = {
        faults: nodeFaultBoxes(v),
        actions: boardActions(e),
        status: nodeStatusRows(v),
        zone: zones.get(e.nodeId) ?? { status: 'none' }
      }
    }
    out[e.nodeId] = p
  }
  return out
}
