// Automatic backups (#136): what one is called, which files in <userData>/backups are ours, which
// of them are kept, and what the list says about each. Pure — BackupFolder reads and writes.
//
// A backup is a configuration file (config-file.ts) written before an import or a restore, named
// `skyhawk-config-<UTC stamp>.json`. Only a file with exactly that name is ours: retention and
// restore never touch anything else in the folder, whatever it is called.
import type { BackupEntry, BackupList } from '@shared/config'
import { stamp } from '@shared/format'
import { parseConfigFile, SECTION_IDS, SECTION_TITLES } from './config-file'

/** How many backups are kept: the newest, after each new one is written. */
export const BACKUP_KEEP = 5

/** The largest file the list or a restore reads, as an import does: a backup is a few KB. */
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024

/** `skyhawk-config-2026-10-16T10-00-00-000Z.json`: stamp() of a UTC time, which is fixed width. */
const BACKUP_NAME = /^skyhawk-config-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/

/** A new backup's file name. */
export const backupFileName = (now: Date): string => `skyhawk-config-${stamp(now)}.json`

/** When a backup was saved, read back from its name (ISO); undefined for any other name. */
export function backupSavedAt(name: string): string | undefined {
  const m = BACKUP_NAME.exec(name)
  if (!m) return undefined
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

/** One of ours: a name this feature writes. Never a path — it has no separator. */
export const isBackupName = (name: string): boolean => backupSavedAt(name) !== undefined

/**
 * Our backups among a folder's names, newest first. The stamp is fixed-width UTC, so name order
 * is time order. Every other name is left out.
 */
export function newestFirst(names: readonly string[]): string[] {
  return names.filter(isBackupName).sort().reverse()
}

/** The backups to delete once a new one is written: ours beyond the newest BACKUP_KEEP. */
export function beyondKeep(names: readonly string[]): string[] {
  return newestFirst(names).slice(BACKUP_KEEP)
}

/**
 * A backup as the list shows it, from its name and its text (undefined: it could not be read).
 * What it was saved before and which sections it holds come from inside the file; one that cannot
 * be read, or a backup written before backups recorded it, still lists, with what is known.
 */
export function backupEntry(name: string, text: string | undefined): BackupEntry {
  const entry: BackupEntry = { file: name, savedAt: backupSavedAt(name) ?? '', sections: [] }
  const parsed = text === undefined ? undefined : parseConfigFile(text)
  if (!parsed?.ok) return entry
  const { sections, backupBefore } = parsed.config
  entry.sections = SECTION_IDS.filter((id) => sections[id] !== undefined).map(
    (id) => SECTION_TITLES[id]
  )
  if (backupBefore) entry.before = backupBefore
  return entry
}

/** The file manager the backups folder opens in, by platform. */
export function fileManager(platform: string): BackupList['fileManager'] {
  if (platform === 'darwin') return 'finder'
  if (platform === 'win32') return 'explorer'
  return 'folder'
}
