// Persist the node mapping to <userData>/node-mapping.json (shape and rules: shared/node-mapping.ts).
// Where that file lives is handed in by app (MappingPaths): this module never asks electron.
//
// Unlike config.json, a lost write here is user work gone (names, adopted boards, hidden boards), so
// failures are reported rather than swallowed, writes are atomic, and a file this build cannot
// safely overwrite — unreadable, or from a newer client — is loaded read-only.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { EMPTY_MAPPING, NODE_MAPPING_VERSION, sanitizeNodeMapping } from '@shared/node-mapping'
import type { NodeMappingFile } from '@shared/nodes/ipc'
import { errorText, stamp } from '@shared/format'

/** A save that did not reach the disk. The message is ready to show. */
export class MappingSaveError extends Error {}

export interface LoadedMapping {
  file: NodeMappingFile
  /** Set when saving must not overwrite what is on disk; the reason is shown on a refused save. */
  readOnly?: string
}

/** Port: where node-mapping.json lives. app provides it; resolved at each use, as before. */
export interface MappingPaths {
  nodeMappingFile(): string
}

const empty = (): NodeMappingFile => ({ ...EMPTY_MAPPING, nodes: {} })

export function loadNodeMapping(paths: MappingPaths): LoadedMapping {
  const p = paths.nodeMappingFile()
  let text: string
  try {
    if (!existsSync(p)) return { file: empty() }
    text = readFileSync(p, 'utf8')
  } catch (err) {
    return { file: empty(), readOnly: `node-mapping.json could not be read: ${errorText(err)}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Move the damaged file aside, so the next save cannot destroy whatever it still holds.
    const bad = `${p}.bad-${stamp(new Date())}`
    try {
      renameSync(p, bad)
      return { file: empty() }
    } catch (err) {
      return {
        file: empty(),
        readOnly: `node-mapping.json is damaged and could not be moved aside: ${errorText(err)}`
      }
    }
  }

  const file = sanitizeNodeMapping(raw)
  const version = (raw as { version?: unknown } | null)?.version
  if (typeof version === 'number' && version > NODE_MAPPING_VERSION) {
    return { file, readOnly: 'node-mapping.json was written by a newer client' }
  }
  return { file }
}

/**
 * Write via a temp file and rename, so a crash mid-write leaves the old file intact rather than
 * half a JSON document. Throws MappingSaveError if the file did not reach the disk.
 */
export function saveNodeMapping(file: NodeMappingFile, paths: MappingPaths): void {
  const p = paths.nodeMappingFile()
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, p)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the write already failed; a stray .tmp is harmless and overwritten next time
    }
    throw new MappingSaveError(`Could not save node mapping: ${errorText(err)}`)
  }
}
