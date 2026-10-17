// Cockpit membership (pure, no Node/Electron deps): which node-mapping entries are in your cockpit
// — a registry board you added, or a board you adopted.
import type { NodeDefaults, NodeKind, NodeMappingFile, NodeOverride } from '@shared/nodes'

/** An adopted node is a non-registry entry complete enough to place: name, console and kind. */
export function adopted(
  o: NodeOverride | undefined
): o is NodeOverride & { name: string; kind: NodeKind } {
  return !!o?.name && !!o.kind
}

/**
 * In your cockpit: a registry board you added, or a board you adopted — and an adopted board stays
 * in it even once its NODE_ID is in NODE_IDS.md (a later registry); the registry is only where
 * names come from, never what decides membership (#93 re-review F). The one rule every check uses.
 */
export const inCockpit = (o: NodeOverride | undefined): boolean => o?.added === true || adopted(o)

/** The NODE_IDs "Also forget adopted nodes" drops — exactly the ones the review lists. */
export function forgettable(defaults: Map<number, NodeDefaults>, file: NodeMappingFile): number[] {
  return Object.keys(file.nodes)
    .map(Number)
    .filter((id) => !defaults.has(id) && adopted(file.nodes[id]))
    .sort((a, b) => a - b)
}
