// The JSON store: the one set of read / parse / write mechanics behind main's three files under
// <userData> (config.json, calibration-cache.json, node-mapping.json). Every file gets the same
// rules (#136, D5 / M6 + X13):
//
//   write  the previous file, if it parses, is kept as `<file>.bak`; then `<file>.tmp` is
//          written, fsynced and renamed over the file, and the folder is fsynced (skipped on
//          Windows, where a folder cannot be opened; the "not supported" errors are ignored
//          elsewhere). A crash at any point leaves a whole file behind, never half of one.
//   read   a file that cannot be read or does not parse falls back to `<file>.bak`. A damaged
//          file is moved aside to `<file>.bad-<stamp>` before anything can overwrite it, and a
//          backup that was loaded is copied back in its place.
//
// The store knows nothing about what a file means. It reports what it found and what it did, in
// words (`note`); the owner decides what that means — defaults, an empty mapping, a read-only
// mapping, an event row — through its own port (nodes' MappingFileIO, hid/calibration's
// CacheFileIO), which a JsonFile satisfies.
import * as nodeFs from 'node:fs'
import { basename, dirname } from 'node:path'
import { errorText, stamp } from '@shared/format'

/** What was wrong with the file itself. */
export type JsonDamage = { kind: 'unreadable'; error: unknown } | { kind: 'damaged' }

/**
 * Where the bad file is now: moved aside, stuck in place because the move failed, or left in place
 * on purpose (a file that could not be read, with no backup to load, may only be busy: the next
 * read tries it again).
 */
export type JsonAside =
  | { kind: 'moved'; to: string }
  | { kind: 'stuck'; error: unknown }
  | { kind: 'left' }

/** What a read found. `note` says, ready to show, what went wrong and what the store did. */
export type JsonRead =
  | { kind: 'missing' }
  | { kind: 'read'; data: unknown }
  /** The file was bad and `<file>.bak` was loaded instead. */
  | { kind: 'fallback'; data: unknown; damage: JsonDamage; aside: JsonAside; note: string }
  /** The file was bad and so was its backup (or there is none): nothing was loaded. */
  | {
      kind: 'failed'
      damage: JsonDamage
      backup: 'missing' | JsonDamage
      aside: JsonAside
      note: string
    }

/** A write that did not reach the disk: the error, and a line saying so. */
export interface JsonWriteError {
  error: unknown
  note: string
}

export interface JsonFile {
  /** Resolves the path (a throw there propagates), then reads and parses the file. */
  read(): JsonRead
  /**
   * Writes `JSON.stringify(value, null, 2)` by the rules above. Returns the failure when the file
   * did not reach the disk (nothing was replaced then); otherwise undefined. The path is resolved
   * outside that guard, so a path that cannot be resolved throws.
   */
  write(value: unknown): JsonWriteError | undefined
}

/** The file-system calls the store makes: node:fs, or a fake in a test. */
export type JsonFs = Pick<
  typeof nodeFs,
  | 'existsSync'
  | 'readFileSync'
  | 'writeFileSync'
  | 'openSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'renameSync'
  | 'rmSync'
>

export interface JsonFileOptions {
  fs?: JsonFs
  /** Where the folder fsync is skipped: `win32`. */
  platform?: NodeJS.Platform
}

/** A folder fsync the platform or file system does not support: the rename stands. */
const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'])

/** One file under the store's mechanics. `path` is resolved at each use. */
export function jsonFile(path: () => string, opts: JsonFileOptions = {}): JsonFile {
  const io = new Mechanics(opts.fs ?? nodeFs, opts.platform ?? process.platform)
  return {
    read: () => io.read(path()),
    write: (value) => {
      const p = path()
      try {
        io.write(p, JSON.stringify(value, null, 2))
      } catch (error) {
        return { error, note: `${basename(p)} could not be saved: ${errorText(error)}` }
      }
      return undefined
    }
  }
}

type Text = { kind: 'text'; text: string } | { kind: 'missing' } | JsonDamage

class Mechanics {
  constructor(
    private readonly fs: JsonFs,
    private readonly platform: NodeJS.Platform
  ) {}

  read(p: string): JsonRead {
    const main = this.parse(this.text(p))
    if (main.kind === 'missing') return main
    if (main.kind === 'read') return { kind: 'read', data: main.data }
    const damage = main
    const name = basename(p)
    const bak = this.parse(this.text(`${p}.bak`))
    if (bak.kind === 'read') {
      const aside = this.moveAside(p)
      // Put the good copy back where it belongs, so the next read finds it (the calibration cache
      // is read on every use). Best effort: `.bak` itself is untouched either way.
      if (aside.kind === 'moved') {
        try {
          this.replace(p, bak.text)
        } catch {
          // the backup is loaded now; until the next save, a later read finds the file missing
        }
      }
      return {
        kind: 'fallback',
        data: bak.data,
        damage,
        aside,
        note: `${what(name, damage)}. Loaded the backup, ${name}.bak.${asideText(aside)}`
      }
    }
    // Nothing to load. A file that does not parse is moved aside so the next save cannot destroy
    // what it still holds; one that could not be read is left for the next read to try again.
    const aside: JsonAside = damage.kind === 'damaged' ? this.moveAside(p) : { kind: 'left' }
    const backup = bak.kind === 'missing' ? bak.kind : bak
    return {
      kind: 'failed',
      damage,
      backup,
      aside,
      note: `${what(name, damage)}, and ${backupText(backup)}.${asideText(aside)}`
    }
  }

  write(p: string, text: string): void {
    // Keep the file this write replaces, if it is a good one: `.bak` is always the last version
    // that parsed. A failure here fails the write, so the file is never replaced without it.
    const prev = this.parse(this.text(p))
    if (prev.kind === 'read') this.replace(`${p}.bak`, prev.text)
    this.replace(p, text)
  }

  /** Write `<p>.tmp`, fsync it, rename it over `p`, then fsync the folder. */
  private replace(p: string, text: string): void {
    const tmp = `${p}.tmp`
    try {
      const fd = this.fs.openSync(tmp, 'w')
      try {
        this.fs.writeFileSync(fd, text)
        this.fs.fsyncSync(fd)
      } finally {
        this.fs.closeSync(fd)
      }
      this.fs.renameSync(tmp, p)
    } catch (err) {
      try {
        this.fs.rmSync(tmp, { force: true })
      } catch {
        // the write already failed; a stray .tmp is harmless and overwritten next time
      }
      throw err
    }
    this.syncDir(dirname(p))
  }

  /** Make the rename itself durable. Windows cannot open a folder to fsync it. */
  private syncDir(dir: string): void {
    if (this.platform === 'win32') return
    let fd: number
    try {
      fd = this.fs.openSync(dir, 'r')
    } catch (err) {
      if (unsupported(err)) return
      throw err
    }
    try {
      this.fs.fsyncSync(fd)
    } catch (err) {
      if (!unsupported(err)) throw err
    } finally {
      this.fs.closeSync(fd)
    }
  }

  private moveAside(p: string): JsonAside {
    const to = `${p}.bad-${stamp(new Date())}`
    try {
      this.fs.renameSync(p, to)
      return { kind: 'moved', to }
    } catch (error) {
      return { kind: 'stuck', error }
    }
  }

  private text(p: string): Text {
    try {
      if (!this.fs.existsSync(p)) return { kind: 'missing' }
      return { kind: 'text', text: this.fs.readFileSync(p, 'utf8') }
    } catch (error) {
      return { kind: 'unreadable', error }
    }
  }

  private parse(
    t: Text
  ): { kind: 'read'; data: unknown; text: string } | Exclude<Text, { kind: 'text' }> {
    if (t.kind !== 'text') return t
    try {
      return { kind: 'read', data: JSON.parse(t.text), text: t.text }
    } catch {
      return { kind: 'damaged' }
    }
  }
}

const unsupported = (err: unknown): boolean =>
  DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException | null)?.code ?? '')

const what = (name: string, d: JsonDamage): string =>
  d.kind === 'damaged' ? `${name} is damaged` : `${name} could not be read (${errorText(d.error)})`

const backupText = (b: 'missing' | JsonDamage): string =>
  b === 'missing'
    ? 'there is no backup'
    : b.kind === 'damaged'
      ? 'its backup is damaged too'
      : `its backup could not be read either (${errorText(b.error)})`

const asideText = (a: JsonAside): string =>
  a.kind === 'moved'
    ? ` The bad copy was kept as ${basename(a.to)}.`
    : a.kind === 'stuck'
      ? ` The bad copy could not be moved aside (${errorText(a.error)}).`
      : ''
