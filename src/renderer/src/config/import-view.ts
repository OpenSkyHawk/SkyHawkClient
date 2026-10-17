// Settings › Configuration wording (#67; R3.4b: the import half of settings-view.ts), pure so it
// is unit-tested: what the Import review and its done line say.
import { day, hhmm, plural } from '@shared/format'

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

/** "Applied 1 section" / "Applied 3 sections · backup saved as skyhawk-config-….json". */
export function importDoneText(applied: number, backupPath?: string): string {
  const done = `Applied ${plural(applied, 'section')}`
  return backupPath ? `${done} · backup saved as ${backupPath.split(/[/\\]/).pop()}` : done
}
