// The node-mapping.json format on disk (shape and rules: mapping-rules.ts): what a read means and
// how a failed write is reported. The file itself is reached through MappingFileIO, which app wires
// to the JSON store (fsync before rename, `.bak` kept, a bad file falls back to its backup and is
// moved aside) — the same mechanics as every other file under <userData>.
//
// What differs here is what a problem means. A lost write is user work gone (names, adopted
// boards, hidden boards), so a failed write is reported to the user (MappingSaveError), and a file
// this build cannot safely overwrite — unreadable, stuck in place, or from a newer client — is
// loaded read-only. A newer client's file is valid, not damaged: it is never replaced by `.bak`.
import { EMPTY_MAPPING, NODE_MAPPING_VERSION, sanitizeNodeMapping } from './mapping-rules'
import type { NodeDefaults, NodeMappingFile } from '@shared/nodes'
import { fileErrorText } from '@shared/format'

/**
 * A save that did not reach the disk. The message is ready to show; `reason` is why, alone, for a
 * caller that names the mapping itself (a config import: "Node mapping could not be saved (…)").
 */
export class MappingSaveError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message)
  }
}

export interface LoadedMapping {
  file: NodeMappingFile
  /** Set when saving must not overwrite what is on disk; the reason is shown on a refused save. */
  readOnly?: string
  /**
   * Read-only because the file could not be loaded (not because a newer client wrote it): the next
   * access tries the load again (M11).
   */
  retry?: true
  /**
   * What went wrong loading the file, and what was done about it: an event row. `warn` when the
   * backup loaded and nothing was lost; `error` when the cockpit is empty or stuck read-only.
   */
  notice?: MappingNotice
}

export interface MappingNotice {
  severity: 'warn' | 'error'
  text: string
}

type Damage = { kind: 'unreadable'; error: unknown } | { kind: 'damaged' }
type Aside = { kind: 'moved'; to: string } | { kind: 'stuck'; error: unknown } | { kind: 'left' }

/**
 * Port: node-mapping.json. `read` resolves the path (a throw there propagates) and reports what it
 * found: the file, its backup loaded in its place, or neither, with a `note` saying what went
 * wrong and where the bad file is now. `write` returns `{ error }` when the file did not reach
 * the disk (a path that cannot be resolved throws instead).
 */
export interface MappingFileIO {
  read():
    | { kind: 'missing' }
    | { kind: 'read'; data: unknown }
    | { kind: 'fallback'; data: unknown; damage: Damage; aside: Aside; note: string }
    | { kind: 'failed'; damage: Damage; aside: Aside; note: string }
  write(file: NodeMappingFile): { error: unknown } | undefined
}

const empty = (): NodeMappingFile => ({ ...EMPTY_MAPPING, nodes: {} })

const UNREADABLE = (error: unknown) =>
  `node-mapping.json could not be read: ${fileErrorText(error)}`
const STUCK = (error: unknown) =>
  `node-mapping.json is damaged and could not be moved aside: ${fileErrorText(error)}`
const NOT_SAVED = ' Cockpit changes are not saved until it can be loaded.'

/**
 * A file that parsed: as written, or read-only when a newer client wrote it. An older file is
 * upgraded against the registry (`defaults`): its links to PDUs outside your cockpit become No power
 * zone (D7, sanitizeNodeMapping).
 */
function fromData(data: unknown, defaults?: Map<number, NodeDefaults>): LoadedMapping {
  const file = sanitizeNodeMapping(data, defaults)
  const version = (data as { version?: unknown } | null)?.version
  if (typeof version === 'number' && version > NODE_MAPPING_VERSION) {
    return { file, readOnly: 'node-mapping.json was written by a newer client' }
  }
  return { file }
}

/** Why a bad file still on disk keeps the mapping read-only: the next save would overwrite it. */
function stuckReason(damage: Damage, aside: Aside): string | undefined {
  if (aside.kind === 'left')
    return damage.kind === 'unreadable' ? UNREADABLE(damage.error) : undefined
  if (aside.kind === 'stuck') {
    return damage.kind === 'unreadable' ? UNREADABLE(damage.error) : STUCK(aside.error)
  }
  return undefined
}

export function loadNodeMapping(
  io: MappingFileIO,
  defaults?: Map<number, NodeDefaults>
): LoadedMapping {
  const r = io.read()
  switch (r.kind) {
    case 'missing':
      return { file: empty() }
    case 'read':
      return fromData(r.data, defaults)
    case 'fallback': {
      // The backup is loaded. If the bad file could not be moved aside, a save would overwrite it.
      const readOnly = stuckReason(r.damage, r.aside)
      if (readOnly) {
        return {
          file: sanitizeNodeMapping(r.data, defaults),
          readOnly,
          retry: true,
          notice: { severity: 'error', text: r.note + NOT_SAVED }
        }
      }
      return { ...fromData(r.data, defaults), notice: { severity: 'warn', text: r.note } }
    }
    case 'failed': {
      const readOnly = stuckReason(r.damage, r.aside)
      if (readOnly) {
        return {
          file: empty(),
          readOnly,
          retry: true,
          notice: { severity: 'error', text: r.note + NOT_SAVED }
        }
      }
      // Moved aside, so the next save cannot destroy whatever the damaged file still holds.
      return {
        file: empty(),
        notice: { severity: 'error', text: `${r.note} Starting with an empty cockpit.` }
      }
    }
  }
}

/**
 * Write the file (durably, by the JSON store's rules: a crash mid-write leaves the old file intact
 * rather than half a JSON document). Throws MappingSaveError if the file did not reach the disk.
 */
export function saveNodeMapping(file: NodeMappingFile, io: MappingFileIO): void {
  const failed = io.write(file)
  if (!failed) return
  const reason = fileErrorText(failed.error)
  throw new MappingSaveError(`Node mapping could not be saved (${reason})`, reason)
}
