// The automatic backups folder, <userData>/backups (#136): writes a backup, deletes ours beyond
// the newest five, lists them, reads one for a restore, and pushes `config:backups` when the list
// changes. The rules (names, order, what to keep, what a row says) are in backups.ts.
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Emit } from '@shared/app'
import type { BackupList } from '@shared/config'
import { fileErrorText } from '@shared/format'
import {
  BACKUP_KEEP,
  BACKUP_MAX_BYTES,
  backupEntry,
  backupFileName,
  backupSavedAt,
  beyondKeep,
  fileManager,
  newestFirst
} from './backups'

export interface BackupFolderDeps {
  /** The folder: <userData>/backups. */
  dir(): string
  /** `config:backups`, when the list changes. */
  emit?: Emit<'config:backups'>
  /** Which file manager Show in … names; process.platform by default. */
  platform?: string
}

/** A backup read for a restore: its text and when it was saved; or why it could not be. */
export type BackupRead =
  | { ok: true; file: string; text: string; savedAt: string }
  | { ok: false; error: string }

export class BackupFolder {
  constructor(private readonly deps: BackupFolderDeps) {}

  /** The newest backups, newest first, at most BACKUP_KEEP. No folder yet: none. */
  list(): BackupList {
    const backups = newestFirst(this.names())
      .slice(0, BACKUP_KEEP)
      .map((name) => backupEntry(name, this.text(name)))
    return {
      backups,
      keep: BACKUP_KEEP,
      fileManager: fileManager(this.deps.platform ?? process.platform)
    }
  }

  /**
   * Write a new backup, then delete ours beyond the newest BACKUP_KEEP, and push the list. Throws
   * when the backup cannot be written: nothing is deleted then. A backup that cannot be deleted
   * is left for the next one to try again.
   */
  save(text: string, now: Date): string {
    const dir = this.deps.dir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, backupFileName(now))
    writeFileSync(path, text)
    for (const name of beyondKeep(this.names())) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // left for the next backup's retention to try again
      }
    }
    this.push()
    return path
  }

  /** One backup's text, for a restore. Only a name this feature writes is read. */
  read(file: unknown): BackupRead {
    const savedAt = typeof file === 'string' ? backupSavedAt(file) : undefined
    if (typeof file !== 'string' || savedAt === undefined) {
      return { ok: false, error: 'Invalid backup request' }
    }
    const path = join(this.deps.dir(), file)
    try {
      if (statSync(path).size > BACKUP_MAX_BYTES) {
        return { ok: false, error: 'This backup is too large to be a configuration file.' }
      }
      return { ok: true, file, text: readFileSync(path, 'utf8'), savedAt }
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') {
        this.push() // the list the renderer holds is out of date
        return { ok: false, error: 'This backup is no longer in the backups folder.' }
      }
      return { ok: false, error: `Could not read the backup (${fileErrorText(err)}).` }
    }
  }

  /** The folder, created if it is not there yet, for Show in Finder to open. */
  ensure(): string {
    const dir = this.deps.dir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // the file manager says what it can't open
    }
    return dir
  }

  /** Push the list as it is on disk now. */
  push(): void {
    this.deps.emit?.('config:backups', this.list())
  }

  /** Every name in the folder; none when there is no folder (or it cannot be read). */
  private names(): string[] {
    try {
      return readdirSync(this.deps.dir())
    } catch {
      return []
    }
  }

  /** A backup's text for the list; undefined when it cannot be read or is too large. */
  private text(name: string): string | undefined {
    const path = join(this.deps.dir(), name)
    try {
      return statSync(path).size > BACKUP_MAX_BYTES ? undefined : readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
}
