// Cockpit membership (pure, no Node/Electron deps): which node-mapping entries are in your cockpit.
// One predicate for the model and every mutator alike (M9), so nothing the model leaves out can be
// edited, hidden or marked seen.
import type { NodeDefaults, NodeKind, NodeMappingFile, NodeOverride } from '@shared/nodes'

/** Complete enough to place without the registry: a name and a kind of its own. */
export function adopted(
  o: NodeOverride | undefined
): o is NodeOverride & { name: string; kind: NodeKind } {
  return !!o?.name && !!o.kind
}

/**
 * In your cockpit: the entry's one marker (`added`, v4) says so — for a registry board you added and
 * a board you adopted alike — and the board can be shown: NODE_IDS.md names it, or the entry has a
 * name and kind of its own. A board you adopted stays in once a later NODE_IDS.md lists it, and a
 * registry board stays in whatever you rename it to (#93 re-review F; S1 bug 1). The registry is
 * only where names come from, never what decides membership.
 */
export function inCockpit(
  defaults: Map<number, NodeDefaults>,
  nodeId: number,
  o: NodeOverride | undefined
): boolean {
  return o?.added === true && (defaults.has(nodeId) || adopted(o))
}

/** The NODE_IDs "Also forget adopted nodes" drops — exactly the ones the review lists. */
export function forgettable(defaults: Map<number, NodeDefaults>, file: NodeMappingFile): number[] {
  return Object.keys(file.nodes)
    .map(Number)
    .filter((id) => !defaults.has(id) && inCockpit(defaults, id, file.nodes[id]))
    .sort((a, b) => a - b)
}
