// The JSON store: the one set of read / parse / write mechanics behind main's three files under
// <userData> (config.json, calibration-cache.json, node-mapping.json). What differs between them
// is a per-file policy object, so each keeps exactly the behaviour it had when it carried its own
// copy of this code (arch-phase0-v2 §1.2, X13).
//
// The store knows nothing about what a file means. It reports what it found; the owner decides
// what that means — defaults, an empty mapping, a read-only mapping — through its own port
// (nodes' MappingFileIO, hid/calibration's CacheFileIO), which a JsonFile satisfies.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { stamp } from '@shared/format'

export interface JsonPolicy {
  /**
   * Write `<file>.tmp` and rename it over the file, removing the temp file if that fails, so a
   * crash mid-write leaves the old file intact. false: write the file in place.
   */
  readonly atomic: boolean
  /**
   * A failed write is handed back to the owner as `{ error }` (node mapping turns it into
   * MappingSaveError). The path is resolved outside that guard, so a path that cannot be resolved
   * throws, as before. false: any failure, the path included, is swallowed.
   */
  readonly reportWriteErrors: boolean
  /**
   * A file that does not parse is renamed to `<file>.bad-<stamp>` before anything can overwrite
   * it. false: it is left where it is.
   */
  readonly moveAsideDamaged: boolean
}

/** Each file's policy: today's behaviour, per file. Changing one is a behaviour change (fix track). */
export const JSON_POLICY = {
  /** config.json: written in place, best effort — a read-only userData must not crash the app. */
  config: { atomic: false, reportWriteErrors: false, moveAsideDamaged: false },
  /** calibration-cache.json: deliberately the same as config.json (a recovery aid, never fatal). */
  calibrationCache: { atomic: false, reportWriteErrors: false, moveAsideDamaged: false },
  /** node-mapping.json: a lost write is user work gone, so atomic, reported, and kept if damaged. */
  nodeMapping: { atomic: true, reportWriteErrors: true, moveAsideDamaged: true }
} as const satisfies Record<string, JsonPolicy>

/** What a read found. A damaged file is reported by what happened to it, per the policy. */
export type JsonRead<MoveAside extends boolean = boolean> =
  | { kind: 'missing' }
  | { kind: 'read'; data: unknown }
  | { kind: 'unreadable'; error: unknown }
  | (MoveAside extends true
      ? { kind: 'movedAside'; to: string } | { kind: 'stuck'; error: unknown }
      : { kind: 'damaged' })

export interface JsonFile<P extends JsonPolicy> {
  /** Resolves the path (a throw there propagates), then reads and parses the file. */
  read(): JsonRead<P['moveAsideDamaged']>
  /**
   * Writes `JSON.stringify(value, null, 2)`, as the policy says. Returns `{ error }` when the
   * write failed and the policy reports it; otherwise undefined.
   */
  write(value: unknown): { error: unknown } | undefined
}

/** One file under the store's mechanics. `path` is resolved at each use. */
export function jsonFile<P extends JsonPolicy>(path: () => string, policy: P): JsonFile<P> {
  return {
    read: () => readJson(path(), policy) as JsonRead<P['moveAsideDamaged']>,
    write: (value) => {
      if (policy.reportWriteErrors) {
        const p = path()
        try {
          writeJson(p, value, policy.atomic)
        } catch (error) {
          return { error }
        }
        return undefined
      }
      try {
        writeJson(path(), value, policy.atomic)
      } catch {
        // best effort, by policy
      }
      return undefined
    }
  }
}

function readJson(p: string, policy: JsonPolicy): JsonRead {
  let text: string
  try {
    if (!existsSync(p)) return { kind: 'missing' }
    text = readFileSync(p, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', error }
  }
  try {
    return { kind: 'read', data: JSON.parse(text) }
  } catch {
    if (!policy.moveAsideDamaged) return { kind: 'damaged' }
    const to = `${p}.bad-${stamp(new Date())}`
    try {
      renameSync(p, to)
      return { kind: 'movedAside', to }
    } catch (error) {
      return { kind: 'stuck', error }
    }
  }
}

function writeJson(p: string, value: unknown, atomic: boolean): void {
  if (!atomic) {
    writeFileSync(p, JSON.stringify(value, null, 2))
    return
  }
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, p)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the write already failed; a stray .tmp is harmless and overwritten next time
    }
    throw err
  }
}
