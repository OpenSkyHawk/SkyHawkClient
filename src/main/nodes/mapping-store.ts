// MappingStore: the node mapping main holds, and how it reaches node-mapping.json. Loaded lazily
// through the MappingFileIO port (the file format: mapping-file.ts; the rules: mapping-rules.ts),
// saved before it is adopted in memory, and refused while the file is read-only. A load that
// failed is tried again on the next access (M11): no timer, and the reason a save is refused is
// the latest one. What went wrong loading the file is an event row (MappingFileEvents).
import type { NodeMappingFile } from '@shared/nodes'
import {
  loadNodeMapping,
  MappingSaveError,
  saveNodeMapping,
  type LoadedMapping,
  type MappingFileIO,
  type MappingNotice
} from './mapping-file'

export { MappingSaveError, type LoadedMapping, type MappingFileIO } from './mapping-file'

/** Port: the debug log, handed in by app (debug.log lives in app). */
type Log = (tag: string, data?: unknown) => void

/**
 * Port: the event log, as node-mapping.json reports to it (app wires the EventJournal). `error`
 * is a client error row, deduped per tag; `forget` makes the tag's next error news again.
 */
export interface MappingFileEvents {
  error(tag: string, message: string): void
  /** The same row at warn: recovered, nothing lost. Same tag and dedupe as `error`. */
  warn(tag: string, message: string): void
  forget(tag: string): void
}

/** The event-log tag of node-mapping.json's rows. */
export const MAPPING_FILE_TAG = 'node-mapping.json'

const NO_EVENTS: MappingFileEvents = { error: () => {}, warn: () => {}, forget: () => {} }

/** Until a file is handed in: fails loudly on first use rather than guess one. */
const NO_FILE: MappingFileIO = {
  read: () => {
    throw new Error('NodeHub: no node-mapping.json path was handed in')
  },
  write: () => {
    throw new Error('NodeHub: no node-mapping.json path was handed in')
  }
}

export interface MappingStoreDeps {
  file?: MappingFileIO
  log?: Log
  /** Where loading the file's problems are reported (the event log). */
  events?: MappingFileEvents
  /** The mapping in memory changed (saved, or kept unsaved by `persist`). */
  onCommit?: () => void
}

export class MappingStore {
  private loaded?: LoadedMapping
  private readonly io: MappingFileIO
  private readonly log: Log
  private readonly events: MappingFileEvents
  private readonly onCommit: () => void
  /** The last load notice reported, so a retry that fails the same way adds nothing. */
  private reported?: string

  constructor(deps: MappingStoreDeps = {}) {
    this.io = deps.file ?? NO_FILE
    this.log = deps.log ?? (() => {})
    this.events = deps.events ?? NO_EVENTS
    this.onCommit = deps.onCommit ?? (() => {})
  }

  /**
   * Read lazily: the userData path is only safe to touch once the app is up. A load that failed
   * (`retry`) is tried again here, on each access, until one succeeds.
   */
  private store(): LoadedMapping {
    if (this.loaded && !this.loaded.retry) return this.loaded
    const next = loadNodeMapping(this.io)
    this.report(next.notice)
    if (!this.loaded) return (this.loaded = next)
    if (next.retry) {
      // Still failing: keep what memory holds, and refuse saves with the latest reason.
      this.loaded.readOnly = next.readOnly
      return this.loaded
    }
    // Loaded at last: the file replaces the stand-in, and read-only clears.
    this.loaded = next
    if (!next.notice) {
      this.reported = undefined
      this.events.forget(MAPPING_FILE_TAG)
    }
    this.onCommit()
    return next
  }

  private report(notice: MappingNotice | undefined): void {
    if (notice === undefined || notice.text === this.reported) return
    this.reported = notice.text
    if (notice.severity === 'warn') this.events.warn(MAPPING_FILE_TAG, notice.text)
    else this.events.error(MAPPING_FILE_TAG, notice.text)
  }

  /** The mapping as main holds it now. */
  mapping(): NodeMappingFile {
    return this.store().file
  }

  /**
   * Save a change main made on its own (not a user edit). If the save fails the change still
   * applies in memory — a reporting board must show, so un-hiding it is right — and may be lost
   * after a restart, which is the lesser problem.
   */
  persist(next: NodeMappingFile): void {
    try {
      this.save(next)
    } catch (err) {
      if (!(err instanceof MappingSaveError)) throw err
      this.log('nodes.mapping', err.message)
      this.commit(next)
    }
  }

  /**
   * Persist, then adopt in memory — never the other way round, or a failed write looks saved.
   * Throws MappingSaveError when read-only or when the write failed. The same file is a no-op.
   */
  save(next: NodeMappingFile): void {
    const loaded = this.store() // one access: a failed load is tried again once, here
    if (next === loaded.file) return
    if (loaded.readOnly) {
      throw new MappingSaveError(`Not saved: ${loaded.readOnly}`, loaded.readOnly)
    }
    saveNodeMapping(next, this.io)
    this.commit(next)
  }

  private commit(next: NodeMappingFile): void {
    this.store().file = next
    this.onCommit()
  }
}
