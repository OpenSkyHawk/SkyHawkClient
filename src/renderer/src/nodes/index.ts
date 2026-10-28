// nodes (R3.4b): the node model, its telemetry and the Cockpit snapshot as main pushes them, and
// the node intents; the Cockpit tab, the Connection tab's nodes card and the status dot.
export { bindNodes, nodesFromMain, useNodesStore, type NodesState } from './store'
export { Cockpit as CockpitTab } from './Cockpit'
export { NodesCard } from './NodesCard'
export { Dot } from './Dot'
export { firmwareBannerText } from './firmware-view'
