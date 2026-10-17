// The node registry (pure, no Node/Electron deps): the bundled NODE_IDS read as defaults per
// NODE_ID — the dictionary names and power zones resolve against.
import type { NodeDefaults, NodeKind } from '@shared/nodes'
import { isNodeId } from './mapping-rules'

/** PDUs are named `PDU_<console>` in NODE_IDS.md, which has no type column. */
const isPduName = (name: string): boolean => /^PDU_/.test(name)

/**
 * Registry defaults, keyed by NODE_ID. NODE_ID 0 (PanelBridge) never appears on the bus and is
 * left out. A panel's default power zone is the PDU on its console when there is exactly one;
 * with none or several there is no safe guess, so it is left unmapped.
 */
export function registryDefaults(
  registry: Record<number, { name: string; console: string }>
): Map<number, NodeDefaults> {
  const ids = Object.keys(registry)
    .map(Number)
    .filter(isNodeId)
    .sort((a, b) => a - b)
  const pdusOn = (console: string) =>
    ids.filter((id) => isPduName(registry[id]!.name) && registry[id]!.console === console)
  const out = new Map<number, NodeDefaults>()
  for (const id of ids) {
    const { name, console } = registry[id]!
    const kind: NodeKind = isPduName(name) ? 'pdu' : 'panel'
    const pdus = kind === 'panel' ? pdusOn(console) : []
    out.set(id, { name, console, kind, pduId: pdus.length === 1 ? pdus[0]! : null })
  }
  return out
}
