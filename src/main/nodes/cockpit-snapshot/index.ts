// The Cockpit snapshot (arch-phase0-v2 §1.2, R3.2): everything the Cockpit tab decides, built once
// in main and pushed on `cockpit:snapshot`. Pure: the time and the revision are handed in.
//
// Your cockpit is one set for every section (members.ts, X1): the boards on the plan and the hidden
// ones. The PDU choices, Add all, Settings' Reset… and Connected nodes' zone names all read it.
//
// A power zone is only ever a PDU in your cockpit (D7). Each board's zone is resolved once here
// (power-zone.ts boardZones: active / hidden / none) and every section reads that: the plan, the
// panels' Powered by, Adopt's pre-fill and Add all, Connected nodes and the zone pickers. Which
// boards a PDU feeds is one rule too (power-zone.ts fedBy, X7): Feeds and Forget count hidden
// boards, an outage only the ones that could have dropped with it.
//
// What is on the bus now is one rule for every section (node-model.ts onBusNow, X2): fresh PDU
// pages count as online, and while the link is down "New on the bus", the strays, the Overview's
// notice, Connected nodes and About's On the bus all say nothing.
//
// What a board outside your cockpit is to the user is one rule too (node-model.ts newState, X3):
// news (it can be adopted: "New on the bus" and the Overview's notice), still identifying, or a
// stray — a warning counted on every tab alike (the Cockpit's band and Attention, the Overview's
// tile and banner, Connected nodes), once an unidentified one has had IDENTIFY_WAIT_MS since it came
// online. Where it comes from is worded once (node-model.ts newReason, X8): "from NODE_IDS.md".
//
// A board's flags are named in one order everywhere (faults.ts NODE_FLAG_ORDER, X6): the tile and
// Attention, the fault boxes and the Adopt evidence.
// Hide and Forget (X5) are offered by the one rule main refuses them by (offline-actions.ts).
// Where clicking a board goes is that membership too (D6, members.ts boardOpens): its panel while
// it is in your cockpit, else the Adopt dialog on its NODE_ID.
//
// The Overview, Connection and Settings read their own sections (R3.2b), from the same views and
// the same strays. The registry's bridge row is "Gateway" (registry-rows.ts registryName).
import type { DeviceStatus } from '@shared/gateway'
import { isLinkUp } from '../../gateway'
import type {
  CockpitSnapshot,
  NodeModel,
  NodeRegistryInfo,
  NodeTelemSnapshot,
  StrayItem
} from '@shared/nodes'
import { adoptRows } from './adopt'
import { cockpitAttention, strayFlag, strayNew } from './attention'
import { cockpitBand, totalWatts } from './band'
import { boardZones } from '../power-zone'
import { boardOpens, cockpitMembers } from './members'
import { boardPanels, zoneChoices } from './panels'
import { planZones } from './plan-zones'
import { settingsNodes } from './registry-rows'
import { nodesSummary, overviewSummary } from './summaries'
import { nodeViews } from './views'

export interface CockpitSnapshotInput {
  /** The node model as last pushed (`nodes:model`); undefined before the first. */
  model?: NodeModel
  /** The PDU pages as NodeHub last took them. */
  telemetry: NodeTelemSnapshot[]
  /** The link and the Gateway's health, as last pushed (`device:status`). */
  device: DeviceStatus
  /** The highest total W this session so far (sessionPeakW). */
  peakW: number
  /** The bundled NODE_IDS registry (`nodes:registry`), for Settings › About. */
  registry?: NodeRegistryInfo
  now: number
  rev: number
}

export interface CockpitBuild {
  snapshot: CockpitSnapshot
  /** When a new board still identifying becomes a stray: build again then (strayNew's nextAt). */
  nextAt?: number
}

export function buildCockpitSnapshot(i: CockpitSnapshotInput): CockpitBuild {
  const views = i.model ? nodeViews(i.model, i.telemetry) : []
  const outages = i.model?.outages ?? []
  const live = isLinkUp(i.device.state)
  const members = cockpitMembers(i.model)
  const zones = boardZones(i.model?.nodes ?? [], members.get)
  // New boards that can't be adopted are active on the bus, so they are warnings (#93) — once an
  // unidentified one has had IDENTIFY_WAIT_MS since it came online to report its kind, so a normal
  // board never flashes. One list for every tab (X3).
  const stray = strayNew(views, i.now, live)
  const strays: StrayItem[] = stray.strays.map((v) => ({
    nodeId: v.entry.nodeId,
    flag: strayFlag(v.entry)
  }))
  const snapshot: CockpitSnapshot = {
    rev: i.rev,
    live,
    views,
    outages,
    plan: planZones(views, outages, zones),
    band: cockpitBand(views, strays.length, i.peakW),
    attention: cockpitAttention(i.model, views, outages, strays, live, i.device.gateway),
    panels: boardPanels(views, outages, members, zones),
    opens: boardOpens(views, members),
    zones: zoneChoices(views, members),
    adopt: adoptRows(views, members),
    overview: overviewSummary(views, outages, strays, live),
    nodesCard: nodesSummary(views, outages, strays, zones, live),
    settings: settingsNodes(i.model, i.registry, live)
  }
  return stray.nextAt === undefined ? { snapshot } : { snapshot, nextAt: stray.nextAt }
}

/**
 * The session's peak W after one more push (the renderer store's rule before R3.2): the total over
 * the placed PDUs' fresh rails, never going down.
 */
export function sessionPeakW(
  peak: number,
  model: NodeModel | undefined,
  telemetry: NodeTelemSnapshot[]
): number {
  const w = model ? (totalWatts(nodeViews(model, telemetry)) ?? 0) : 0
  return Math.max(peak, w)
}
