// MappingStore: the node mapping main holds, and how it reaches node-mapping.json. Loaded lazily
// through the MappingFileIO port (the file format: mapping-file.ts; the rules: mapping-rules.ts),
// saved before it is adopted in memory, and refused while the file is read-only.
import type { NodeMappingFile } from '@shared/nodes'
import {
  loadNodeMapping,
  MappingSaveError,
  saveNodeMapping,
  type LoadedMapping,
  type MappingFileIO
} from './mapping-file'

export { MappingSaveError, type LoadedMapping, type MappingFileIO } from './mapping-file'

/** Port: the debug log, handed in by app (debug.log lives in app). */
type Log = (tag: string, data?: unknown) => void

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
  /** The mapping in memory changed (saved, or kept unsaved by `persist`). */
  onCommit?: () => void
}

export class MappingStore {
  private loaded?: LoadedMapping
  private readonly io: MappingFileIO
  private readonly log: Log
  private readonly onCommit: () => void

  constructor(deps: MappingStoreDeps = {}) {
    this.io = deps.file ?? NO_FILE
    this.log = deps.log ?? (() => {})
    this.onCommit = deps.onCommit ?? (() => {})
  }

  /** Read lazily: the userData path is only safe to touch once the app is up. */
  private store(): LoadedMapping {
    return (this.loaded ??= loadNodeMapping(this.io))
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
    if (next === this.mapping()) return
    const { readOnly } = this.store()
    if (readOnly) throw new MappingSaveError(`Not saved: ${readOnly}`)
    saveNodeMapping(next, this.io)
    this.commit(next)
  }

  private commit(next: NodeMappingFile): void {
    this.store().file = next
    this.onCommit()
  }
}
