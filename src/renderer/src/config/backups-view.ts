// Settings › Configuration › Automatic backups wording (#136), pure so it is unit-tested: the
// list main pushes (`config:backups`) into the section's header, rows and hint, and how a restore
// is named in the review. Main decides which backups there are and what each holds.
import type { BackupBefore, BackupEntry, BackupList } from '@shared/config'
import { day, hhmm } from '@shared/format'

/** "2026-10-17 09:49": when a backup was saved, local time. */
export function backupWhen(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 'an unknown time' : `${day(t)} ${hhmm(t)}`
}

/**
 * What a backup was saved before, completing "Before …" / "saved before …": "importing
 * cockpit.json", "restoring the backup from 2026-10-16 22:14", or — a backup from before backups
 * recorded it — "an import".
 */
export function beforeText(before?: BackupBefore): string {
  if (!before) return 'an import'
  return before.kind === 'import'
    ? `importing ${before.fileName}`
    : `restoring the backup from ${backupWhen(before.savedAt)}`
}

/** "App settings, node mapping, power supply": main's section titles as one list. */
export function sectionList(titles: readonly string[]): string {
  return titles.map((t, i) => (i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1))).join(', ')
}

/** A row's description: "Before importing cockpit.json · App settings, node mapping". */
export function backupDesc(entry: BackupEntry): string {
  const head = `Before ${beforeText(entry.before)}`
  return entry.sections.length > 0 ? `${head} · ${sectionList(entry.sections)}` : head
}

/** The header's count, "3 of 5"; nothing while there are none. */
export function backupCount(list: BackupList): string {
  return list.backups.length > 0 ? `${list.backups.length} of ${list.keep}` : ''
}

/** The header's button, by the file manager main says the folder opens in. */
export function showFolderLabel(fileManager: BackupList['fileManager']): string {
  if (fileManager === 'finder') return 'Show in Finder'
  if (fileManager === 'explorer') return 'Show in Explorer'
  return 'Show in folder'
}

/** The empty list. */
export const BACKUPS_EMPTY =
  'No backups yet. One is saved each time you import with “Save a backup of the current setup first” ticked.'

/** The hint below the list. */
export function backupHint(keep: number): string {
  return `Saved before each import, in the app’s settings folder. The newest ${keep} are kept; older ones are removed. Restore shows what it would change first, like an import.`
}
