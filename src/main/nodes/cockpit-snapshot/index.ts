// The Cockpit snapshot (arch-phase0-v2 §1.2, R3.2): everything the Cockpit tab decides, built once
// in main and pushed on `cockpit:snapshot`. Pure: the time and the revision are handed in.
//
// Your cockpit is one set for every section (members.ts, X1): the boards on the plan and the hidden
// ones. The PDU choices, Add all, Settings' Reset… and Connected nodes' zone names all read it.
//
// Where the Cockpit and another surface answer differently today, this builder keeps the Cockpit's
// own answer as its own function (X2–X8 option a, co-located, not unified — the fix track does
// that):
//   X2 on the bus unplugged strays and Attention items only while the link is up
//                           (attention.ts cockpitAttention, here)
//   X3 strays               counted in the Cockpit's band, online and warning (band.ts
//                           cockpitBand); the "New on the bus" count is isReportableNew
//                           (attention.ts newCount); strays wait IDENTIFY_WAIT_MS (strayNew)
//   X4 zone choices         powerZoneOptions / firstPduOn (panel Settings), adoptPduChoices
//                           "(not added)" and addAllPduId (Adopt), poweredBy any source (panels.ts
//                           boardPanels), No power zone for a PDU not on the plan (planZones)
//   X6 fault order          the tile and Attention (views.ts nodeHealth), the fault boxes
//                           (panels.ts nodeFaultBoxes / pduFaultBoxes), the Adopt evidence
//                           (adopt.ts adoptEvidence)
//   X7 fed boards           a PDU's Feeds and what Forget unlinks (panels.ts boardPanels); an
//                           outage's fed count is power-zone.ts pduOutages
//   X8 registry wording     NOT IN REGISTRY / "Not in registry" for a new board (views.ts,
//                           panels.ts)
// Hide and Forget (X5) are offered by the one rule main refuses them by (offline-actions.ts).
//
// The Overview, Connection and Settings read their own sections (R3.2b), each with its own answer
// where it differs from the Cockpit's — the same option a, co-located:
//   X2 on the bus unplugged the Overview's banner and notice only while the link is up; Connected
//                           nodes and the registry's CAN rows read the last model whatever the link
//                           (summaries.ts, registry-rows.ts registryOnBus)
//   X3 strays               the Overview and Connection count none (summaries.ts: healthBand and
//                           attentionItems with no strays); the notice is isReportableNew
//                           (newDevices)
//   X4 zone                 a Connected nodes row names its zone's PDU wherever it is, else "no
//                           power zone" (summaries.ts nodesSummary)
//   X8 registry wording     the registry's bridge row is "Gateway" (registry-rows.ts registryName)
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
import { cockpitMembers } from './members'
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
  // New boards that can't be adopted are active on the bus, so they are warnings (#93) — once an
  // unidentified one has had IDENTIFY_WAIT_MS to report its kind, so a normal board never flashes.
  const stray = strayNew(views, i.now)
  const strays: StrayItem[] = live
    ? stray.strays.map((v) => ({ nodeId: v.entry.nodeId, flag: strayFlag(v.entry) }))
    : []
  const snapshot: CockpitSnapshot = {
    rev: i.rev,
    live,
    views,
    outages,
    plan: planZones(views, outages),
    band: cockpitBand(views, strays.length, i.peakW),
    attention: cockpitAttention(i.model, views, outages, strays, live, i.device.gateway),
    panels: boardPanels(views, outages, i.telemetry),
    zones: zoneChoices(views, members),
    adopt: adoptRows(views, members),
    overview: overviewSummary(views, outages, live),
    nodesCard: nodesSummary(views, outages, members),
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
