// The Cockpit snapshot (arch-phase0-v2 §1.2, R3.2): everything the Cockpit tab decides, built once
// in main and pushed on `cockpit:snapshot`. Pure: the time and the revision are handed in.
//
// Where the Cockpit and another surface answer differently today, this builder keeps the Cockpit's
// own answer as its own function (X1–X8 option a, co-located, not unified — the fix track does
// that):
//   X1 hidden in cockpit    the PDU choices, Add all and the plan see the boards on the plan only:
//                           a hidden PDU is not "in your cockpit" here (adopt.ts addAllPduId,
//                           panels.ts powerZoneOptions / firstPduOn, plan-zones.ts planZones)
//   X2 on the bus unplugged strays and Attention items only while the link is up
//                           (attention.ts cockpitAttention, here)
//   X3 strays               counted in the Cockpit's band, online and warning (band.ts
//                           cockpitBand); the "New on the bus" count is isReportableNew
//                           (attention.ts newCount); strays wait IDENTIFY_WAIT_MS (strayNew)
//   X4 zone choices         powerZoneOptions / firstPduOn (panel Settings), adoptPduChoices
//                           "(not added)" and addAllPduId (Adopt), poweredBy any source (panels.ts
//                           boardPanels), No power zone for a PDU not on the plan (planZones)
//   X5 Forget / Hide        offered once the model says offline (panels.ts boardActions); main's
//                           own guard is NodeHub.onlineRefusal
//   X6 fault order          the tile and Attention (views.ts nodeHealth), the fault boxes
//                           (panels.ts nodeFaultBoxes / pduFaultBoxes), the Adopt evidence
//                           (adopt.ts adoptEvidence)
//   X7 fed boards           a PDU's Feeds and what Forget unlinks (panels.ts boardPanels); an
//                           outage's fed count is power-zone.ts pduOutages
//   X8 registry wording     NOT IN REGISTRY / "Not in registry" for a new board (views.ts,
//                           panels.ts)
// Overview, Connection and Settings keep their own copies until R3.2b.
import { isLinkUp, type DeviceStatus } from '@shared/gateway'
import type { CockpitSnapshot, NodeModel, NodeTelemSnapshot, StrayItem } from '@shared/nodes'
import { adoptRows } from './adopt'
import { cockpitAttention, strayFlag, strayNew } from './attention'
import { cockpitBand, totalWatts } from './band'
import { boardPanels, zoneChoices } from './panels'
import { planZones } from './plan-zones'
import { nodeViews } from './views'

export interface CockpitSnapshotInput {
  /** The node model as last pushed (`nodes:model`); undefined before the first. */
  model?: NodeModel
  /** The telemetry as last pushed (`nodes:telemetry`). */
  telemetry: NodeTelemSnapshot[]
  /** The link and the Gateway's health, as last pushed (`device:status`). */
  device: DeviceStatus
  /** The highest total W this session so far (sessionPeakW). */
  peakW: number
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
    panels: boardPanels(views, outages),
    zones: zoneChoices(views),
    adopt: adoptRows(views)
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
