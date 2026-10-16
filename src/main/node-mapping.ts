// Persist the node mapping to <userData>/node-mapping.json (shape and rules: shared/node-mapping.ts).
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_MAPPING, sanitizeNodeMapping, type NodeMappingFile } from '@shared/node-mapping'

function mappingPath(): string {
  return join(app.getPath('userData'), 'node-mapping.json')
}

export function loadNodeMapping(): NodeMappingFile {
  try {
    const p = mappingPath()
    if (!existsSync(p)) return { ...EMPTY_MAPPING, nodes: {}, ignored: [] }
    return sanitizeNodeMapping(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return { ...EMPTY_MAPPING, nodes: {}, ignored: [] }
  }
}

export function saveNodeMapping(file: NodeMappingFile): void {
  try {
    writeFileSync(mappingPath(), JSON.stringify(file, null, 2))
  } catch {
    // best-effort; a read-only userData dir shouldn't crash the app
  }
}
