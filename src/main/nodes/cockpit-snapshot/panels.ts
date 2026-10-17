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
  type NodeModelEntry,
  type NodeView,
  type PduOutage,
  type PduRailPage,
  type RailRow,
  type Row,
  type ZoneChoices
} from '@shared/nodes'
import { PDU_STATUS_FLAGS as PDU_FLAG } from '@shared/firmware'
import { nodeFaultTag, pduAlertFlags, pduFlagMeanings } from '../faults'
import { displayCurrentMa } from '../node-telem'

// ── board actions ───────────────────────────────────────────────────────────

const ONLINE_NOTE =
  'Online — it’s active on the bus, so it can’t be removed. Forget and Hide work once it’s offline.'
/** No complete roster yet: whether it is on the bus is not known — not "online" (#93 review). */
const NO_ROSTER_NOTE =
  'No roster yet — connect the Gateway. Forget and Hide work once the board shows offline.'

/**
 * Same rules for a panel group and a PDU (#93). Hide and Forget only tidy the display, and a board
 * that is online is active on the bus, so both wait until it is offline (main refuses them too —
 * X5 co-located: this offers them only once the model says offline; NodeHub.onlineRefusal refuses
 * only while the roster lists the board present).
 * `fed` = boards in your cockpit this PDU feeds (Forget unlinks them; Hide keeps the links).
 */
export function boardActions(e: NodeModelEntry, fed = 0): BoardActions {
  const offline = e.availability === 'offline'
  const why = e.availability === 'unknown' ? NO_ROSTER_NOTE : ONLINE_NOTE
  const off = (tip: string): BoardAction => ({
    disabled: !offline,
    tip: offline ? tip : why
  })
  const a: BoardActions = {
    forget: off(
      e.kind === 'pdu'
        ? 'Remove it from your cockpit; its boards lose the link'
        : 'Remove it from your cockpit and the saved mapping'
    ),
    hide: off(
      e.kind === 'pdu'
        ? 'Hide until it reports again; its boards keep the link'
        : 'Hide until it reports again'
    ),
    note: why
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
  if (!offline) return a
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
 * the order the tile and Attention name them in — so a second fault never hides behind the first.
 */
export function nodeFaultBoxes(v: NodeView): FaultBox[] {
  const e = v.entry
  const st = e.status
  if (e.source === 'new') {
    return [
      {
        tone: 'new',
        title: 'Not in registry',
        text: 'this NODE_ID is not in the bundled NODE_IDS.md. Name it and place it on the map.'
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
  const out: FaultBox[] = []
  if (st.boff) {
    out.push({
      tone: 'err',
      title: 'Bus-off',
      text: 'its CAN controller stopped transmitting after too many errors. Reported by the node.'
    })
  }
  if (st.degraded) {
    out.push({
      tone: 'warn',
      title: st.faultLabel ?? nodeFaultTag(st),
      text: st.faultDesc || 'reported by the node; this client has no description for this code.'
    })
  }
  if (st.overheat) {
    out.push({ tone: 'warn', title: 'Overheat', text: 'the node raised its own temperature trip.' })
  }
  if (st.epvf) {
    out.push({
      tone: 'warn',
      title: 'Error-passive',
      text: 'its CAN error counters are high; it still communicates but can only signal errors passively.'
    })
  }
  return out
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
      v: live ? (live.boff ? 'bus-off' : live.epvf ? 'error-passive' : 'error-active') : DASH
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

/**
 * Every Power zone list the forms can ask for (X4 co-located: the panel's Settings tab and the
 * Adopt form both read these, through `powerZoneOptions` and `firstPduOn`): for each console a
 * form can hold — the three NODE_IDS.md consoles, none yet, and any console a board or its
 * NODE_IDS.md row names — with no zone (or one not in your cockpit), and with each PDU in your
 * cockpit as the stored zone.
 */
export function zoneChoices(views: NodeView[]): ZoneChoices {
  const consoles = new Set<string>(['', ...CONSOLE_OPTIONS.map((c) => c.value)])
  for (const v of views) {
    if (v.entry.console !== null) consoles.add(v.entry.console)
    if (v.entry.registry) consoles.add(v.entry.registry.console)
  }
  const placed = views
    .filter((v) => v.entry.kind === 'pdu' && v.entry.source !== 'new')
    .map((v) => v.entry.nodeId)
  const out: ZoneChoices = { options: {}, first: {} }
  for (const c of consoles) {
    const byZone: Record<string, { value: number; label: string }[]> = {
      '': powerZoneOptions(views, c, null)
    }
    for (const id of placed) byZone[id] = powerZoneOptions(views, c, id)
    out.options[c] = byZone
    out.first[c] = firstPduOn(views, c)
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
 * Every board's side panel. A panel group is powered by the PDU its zone names, placed or not (X4
 * co-located: the plan puts it under that PDU only once the PDU is placed). A PDU feeds the panel
 * groups in your cockpit whose zone it is; that count is what Forget says it unlinks (X7
 * co-located: an outage counts the fed boards seen this session, pduOutages).
 */
export function boardPanels(views: NodeView[], outages: PduOutage[]): Record<number, BoardPanel> {
  const out: Record<number, BoardPanel> = {}
  for (const v of views) {
    const e = v.entry
    const placed = e.source !== 'new'
    let p: BoardPanel
    if (e.kind === 'pdu') {
      const feeds = views.filter(
        (n) => n.entry.kind === 'panel' && n.entry.source !== 'new' && n.entry.pduId === e.nodeId
      )
      p = {
        placed,
        faults: pduFaultBoxes(
          v,
          outages.some((o) => o.pduId === e.nodeId)
        ),
        actions: boardActions(e, feeds.length),
        rails: pduRailRows(v),
        board: pduBoardRows(v),
        feeds: feeds.map((n) => ({ nodeId: n.entry.nodeId, detail: feedState(n) })),
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
      const pdu = views.find((o) => o.entry.kind === 'pdu' && o.entry.nodeId === e.pduId)
      p = {
        placed,
        faults: nodeFaultBoxes(v),
        actions: boardActions(e),
        status: nodeStatusRows(v)
      }
      if (pdu) p.poweredBy = pdu.entry.nodeId
    }
    out[e.nodeId] = p
  }
  return out
}
