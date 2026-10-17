// The node-mapping.json format on disk (shape and rules: mapping-rules.ts): what a read means and
// how a failed write is reported. The file itself is reached through MappingFileIO, which app wires
// to the JSON store under node-mapping.json's policy (atomic write, failures reported, a damaged
// file moved aside).
//
// Unlike config.json, a lost write here is user work gone (names, adopted boards, hidden boards), so
// failures are reported rather than swallowed, writes are atomic, and a file this build cannot
// safely overwrite — unreadable, or from a newer client — is loaded read-only.
import { EMPTY_MAPPING, NODE_MAPPING_VERSION, sanitizeNodeMapping } from './mapping-rules'
import type { NodeMappingFile } from '@shared/nodes'
import { errorText } from '@shared/format'

/** A save that did not reach the disk. The message is ready to show. */
export class MappingSaveError extends Error {}

export interface LoadedMapping {
  file: NodeMappingFile
  /** Set when saving must not overwrite what is on disk; the reason is shown on a refused save. */
  readOnly?: string
}

/**
 * Port: node-mapping.json. `read` resolves the path (a throw there propagates) and reports what it
 * found, a damaged file already moved aside or stuck in place. `write` returns `{ error }` when the
 * file did not reach the disk (a path that cannot be resolved throws instead).
 */
export interface MappingFileIO {
  read():
    | { kind: 'missing' }
    | { kind: 'read'; data: unknown }
    | { kind: 'unreadable'; error: unknown }
    | { kind: 'movedAside'; to: string }
    | { kind: 'stuck'; error: unknown }
  write(file: NodeMappingFile): { error: unknown } | undefined
}

const empty = (): NodeMappingFile => ({ ...EMPTY_MAPPING, nodes: {} })

export function loadNodeMapping(io: MappingFileIO): LoadedMapping {
  const r = io.read()
  switch (r.kind) {
    case 'missing':
      return { file: empty() }
    case 'unreadable':
      return {
        file: empty(),
        readOnly: `node-mapping.json could not be read: ${errorText(r.error)}`
      }
    // Moved aside, so the next save cannot destroy whatever the damaged file still holds.
    case 'movedAside':
      return { file: empty() }
    case 'stuck':
      return {
        file: empty(),
        readOnly: `node-mapping.json is damaged and could not be moved aside: ${errorText(r.error)}`
      }
  }

  const file = sanitizeNodeMapping(r.data)
  const version = (r.data as { version?: unknown } | null)?.version
  if (typeof version === 'number' && version > NODE_MAPPING_VERSION) {
    return { file, readOnly: 'node-mapping.json was written by a newer client' }
  }
  return { file }
}

/**
 * Write the file (atomically, by its policy: a crash mid-write leaves the old file intact rather
 * than half a JSON document). Throws MappingSaveError if the file did not reach the disk.
 */
export function saveNodeMapping(file: NodeMappingFile, io: MappingFileIO): void {
  const failed = io.write(file)
  if (failed) throw new MappingSaveError(`Could not save node mapping: ${errorText(failed.error)}`)
}
