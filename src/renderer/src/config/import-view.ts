// Settings › Configuration wording (#67; R3.4b: the import half of settings-view.ts), pure so it
// is unit-tested: what the Import review and its done line say — and, when the file is one of the
// automatic backups (#136), the same review as a restore.
import type { ImportPreview } from '@shared/config'
import { day, hhmm, plural } from '@shared/format'
import { backupWhen, beforeText } from './backups-view'

/** Import review subtitle: "skyhawk-config.json · exported 2026-10-12 21:02 · client v0.2.0". */
export function importSubtitle(p: {
  fileName: string
  exportedAt?: string
  client?: string
}): string {
  const parts = [p.fileName]
  const t = p.exportedAt ? Date.parse(p.exportedAt) : NaN
  if (!Number.isNaN(t)) parts.push(`exported ${day(t)} ${hhmm(t)}`)
  if (p.client) parts.push(`client v${p.client}`)
  return parts.join(' · ')
}

/**
 * What the review says when nothing would change: the whole file matches, or — when main left
 * sections out as malformed (`rejected`, listed below it as skipped) — only the readable ones do.
 */
export function identicalText(p: { rejected: readonly unknown[] }): string {
  return p.rejected.length > 0
    ? 'The readable sections match your current setup'
    : 'This file matches your current setup'
}

/** A review row's key: calibration rows name the axis, and the board when there are several. */
export function importRowKey(
  r: { k: string; axis?: number; board?: string },
  axisLabels: readonly string[],
  severalBoards: boolean
): string {
  if (r.axis === undefined) return r.k
  const name = axisLabels[r.axis] ?? r.k
  return severalBoards && r.board ? `${name} · ${r.board}` : name
}

/** The review's title: "Import configuration", or "Restore backup" for an automatic backup. */
export function reviewTitle(p: Pick<ImportPreview, 'backup'>): string {
  return p.backup ? 'Restore backup' : 'Import configuration'
}

/**
 * The review's subtitle: the file's (importSubtitle), or for a restore "Automatic backup ·
 * 2026-10-17 09:49 · saved before importing cockpit.json".
 */
export function reviewSubtitle(p: ImportPreview): string {
  if (!p.backup) return importSubtitle(p)
  return `Automatic backup · ${backupWhen(p.backup.savedAt)} · saved before ${beforeText(p.backup.before)}`
}

/** The apply button: "Apply 2 sections", or "Restore 2 sections" for a restore. */
export function applyLabel(p: Pick<ImportPreview, 'backup'>, picked: number): string {
  return `${p.backup ? 'Restore' : 'Apply'} ${plural(picked, 'section')}`
}

/** "Applied 1 section" / "Applied 3 sections · backup saved, listed under Automatic backups". */
export function importDoneText(applied: number, backedUp: boolean): string {
  const done = `Applied ${plural(applied, 'section')}`
  return backedUp ? `${done} · backup saved, listed under Automatic backups` : done
}

/**
 * A restore's done line: "Restored the backup from 2026-10-17 09:49", and when the setup it
 * replaced was saved first, "· the setup before it was backed up first".
 */
export function restoreDoneText(savedAt: string, backedUp: boolean): string {
  const done = `Restored the backup from ${backupWhen(savedAt)}`
  return backedUp ? `${done} · the setup before it was backed up first` : done
}
