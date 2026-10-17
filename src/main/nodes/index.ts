// nodes: the CAN node picture and the node mapping. Exports only what other topics use
// (arch-phase0-v2 §2.1).
export { NodeHub } from './node-hub'
export type { MappingFileIO } from './mapping-store'
export { NodeRoster } from './node-status-wire'
// The mapping and PSU rules config's file format reads a section back through.
export {
  effectiveMapping,
  importMapping,
  isPlainObject,
  sanitizeNodeMapping
} from './mapping-rules'
export { PSU_PRESETS, resolvePsu, sanitizePsu } from './psu-limits'
export { registerNodesIpc } from './ipc'
