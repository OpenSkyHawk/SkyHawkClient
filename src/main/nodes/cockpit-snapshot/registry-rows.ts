// What Settings shows about the node mapping (moved from the renderer's settings-view.ts and the
// Settings sections, R3.2b): Reset…'s gate, the Hidden boards list, and About › Node registry — its
// summary line and each row's "On the bus".
//
// Each keeps Settings' own answer where it differs from the Cockpit's (co-located, not unified):
//   X1 in cockpit  Reset… counts an adopted board only while it is on the plan: a hidden adopted
//                  board is missed (anyAdopted)
//   X2 on the bus  a CAN row reads the last model whatever the link; only the Gateway row follows
//                  the link (registryOnBus)
//   X8 wording     the bridge row is "Gateway", whatever NODE_IDS.md calls it (registryName)
import { GATEWAY_NODE_ID } from '@shared/firmware'
import { plural } from '@shared/format'
import type { NodeModel, NodeRegistryInfo, OnBus, RegistryRow, SettingsNodes } from '@shared/nodes'

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
 * the roster says — "—" before any roster, since that is no data rather than "absent".
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
  if (e?.availability === 'online') return { text: 'yes', dot: 'on' }
  if (e?.availability === 'offline') return { text: 'offline', dot: 'off' }
  return { text: '—', dot: '' }
}

/**
 * Settings' sections, as CockpitSection and AboutSection computed them from the model: the
 * differing count, Reset… enabled when something differs or any adopted board is on the plan
 * (X1), the hidden boards, and the registry rows. No registry yet (the launch snapshot): no rows.
 */
export function settingsNodes(
  model: NodeModel | undefined,
  registry: NodeRegistryInfo | undefined,
  live: boolean
): SettingsNodes {
  const differing = model?.differingCount ?? 0
  const anyAdopted = model?.nodes.some((n) => n.source === 'adopted') ?? false
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
