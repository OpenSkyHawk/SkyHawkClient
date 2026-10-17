// What Settings shows about the node mapping (moved from the renderer's Settings sections,
// R3.2b): Reset…'s gate, the Hidden boards list, and About › Node registry — its
// summary line and each row's "On the bus".
//
// Reset… reads your cockpit as every surface does (members.ts, X1): a hidden adopted board is still
// one it can forget.
//
// "On the bus" is the one rule every surface reads (node-model.ts onBusNow, X2): with the link down
// no CAN row says yes or offline. Settings keeps its own answer where it differs from the Cockpit's
// (co-located, not unified):
//   X8 wording     the bridge row is "Gateway", whatever NODE_IDS.md calls it (registryName)
import { GATEWAY_NODE_ID } from '@shared/firmware'
import { plural } from '@shared/format'
import type { NodeModel, NodeRegistryInfo, OnBus, RegistryRow, SettingsNodes } from '@shared/nodes'
import { onBusNow } from '../node-model'
import { cockpitMembers } from './members'

/**
 * A registry row's name as the client shows it: the bridge row is the Gateway (#94), whatever
 * NODE_IDS.md calls it (the firmware name, PanelBridge).
 */
export function registryName(n: NodeRegistryInfo['nodes'][number]): string {
  return n.kind === 'bridge' ? 'Gateway' : n.name
}

/** "NODE_IDS.md · 6 nodes: 3 PDUs, 2 panel groups, Gateway". */
export function registrySummary(r: NodeRegistryInfo): string {
  const pdus = r.nodes.filter((n) => n.kind === 'pdu').length
  const panels = r.nodes.filter((n) => n.kind === 'panel').length
  const parts = [plural(pdus, 'PDU'), plural(panels, 'panel group')]
  const bridge = r.nodes.find((n) => n.kind === 'bridge')
  if (bridge) parts.push(registryName(bridge))
  const file = r.file.split('/').pop()
  return `${file} · ${plural(r.nodes.length, 'node')}: ${parts.join(', ')}`
}

/**
 * Registry list "On the bus" column. PanelBridge is the serial link itself; a CAN node is what
 * the one availability rule says while the link is up (onBusNow) — "—" before any roster, and
 * while the link is down, since that is no data rather than "absent". Hidden is your cockpit's,
 * not the bus's: it reads so whatever the link.
 */
export function registryOnBus(
  nodeId: number,
  model: NodeModel | undefined,
  linkUp: boolean
): OnBus {
  if (nodeId === GATEWAY_NODE_ID)
    return linkUp ? { text: 'serial link', dot: 'on' } : { text: 'no device', dot: '' }
  if (model?.hidden.includes(nodeId)) return { text: 'hidden', dot: '' }
  const e = model?.nodes.find((n) => n.nodeId === nodeId)
  if (!e || !linkUp) return { text: '—', dot: '' }
  if (onBusNow(e, linkUp)) return { text: 'yes', dot: 'on' }
  if (e.availability === 'offline') return { text: 'offline', dot: 'off' }
  return { text: '—', dot: '' }
}

/**
 * Settings' sections, as CockpitSection and AboutSection computed them from the model: the
 * differing count, Reset… enabled when something differs or any adopted board is in your cockpit —
 * hidden ones included, since "Also forget adopted nodes" forgets them too (X1, R4) — the hidden
 * boards, and the registry rows. No registry yet (the launch snapshot): no rows.
 */
export function settingsNodes(
  model: NodeModel | undefined,
  registry: NodeRegistryInfo | undefined,
  live: boolean
): SettingsNodes {
  const differing = model?.differingCount ?? 0
  const anyAdopted = cockpitMembers(model).all.some((m) => m.source === 'adopted')
  const rows = (registry?.nodes ?? []).map(
    (n): RegistryRow => ({
      nodeId: n.nodeId,
      name: registryName(n),
      console: n.console,
      onBus: registryOnBus(n.nodeId, model, live),
      unloaded: registryOnBus(n.nodeId, undefined, live)
    })
  )
  return {
    differing,
    canReset: !(differing === 0 && !anyAdopted),
    hidden: model?.hiddenNodes ?? [],
    registry: { summary: registry ? registrySummary(registry) : '', rows }
  }
}
