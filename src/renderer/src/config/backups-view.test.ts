import { describe, expect, it } from 'vitest'
import type { BackupList } from '@shared/config'
import {
  backupCount,
  backupDesc,
  backupWhen,
  beforeText,
  sectionList,
  showFolderLabel
} from './backups-view'
import {
  applyLabel,
  importDoneText,
  restoreDoneText,
  reviewSubtitle,
  reviewTitle
} from './import-view'

const at = new Date(2026, 9, 17, 9, 49).toISOString()
const earlier = new Date(2026, 9, 15, 19, 3).toISOString()

describe('Automatic backups wording (#136)', () => {
  it('a backup’s time, local', () => {
    expect(backupWhen(at)).toBe('2026-10-17 09:49')
    expect(backupWhen('not a time')).toBe('an unknown time')
  })

  it('what a backup was saved before, and what it holds', () => {
    expect(beforeText({ kind: 'import', fileName: 'cockpit.json' })).toBe('importing cockpit.json')
    expect(beforeText({ kind: 'restore', savedAt: earlier })).toBe(
      'restoring the backup from 2026-10-15 19:03'
    )
    expect(beforeText(undefined)).toBe('an import')
    expect(sectionList(['App settings', 'Node mapping', 'Axis calibration'])).toBe(
      'App settings, node mapping, axis calibration'
    )
    expect(backupDesc({ file: 'f', savedAt: at, sections: [] })).toBe('Before an import')
  })

  it('the header: a count out of the kept number, and the file manager’s name', () => {
    const list = (n: number): BackupList => ({
      keep: 5,
      fileManager: 'finder',
      backups: Array.from({ length: n }, (_, i) => ({ file: `${i}`, savedAt: at, sections: [] }))
    })
    expect(backupCount(list(0))).toBe('')
    expect(backupCount(list(3))).toBe('3 of 5')
    expect(showFolderLabel('finder')).toBe('Show in Finder')
    expect(showFolderLabel('explorer')).toBe('Show in Explorer')
    expect(showFolderLabel('folder')).toBe('Show in folder')
  })

  it('the review as a restore, and the done lines', () => {
    const restore = {
      backup: { savedAt: at, before: { kind: 'import' as const, fileName: 'a.json' } }
    }
    const file = { token: 't', fileName: 'f.json', sections: [], skipped: [], rejected: [] }
    const preview = { ...file, identical: false, ...restore } as const
    expect(reviewTitle(preview)).toBe('Restore backup')
    expect(reviewTitle({})).toBe('Import configuration')
    expect(reviewSubtitle(preview)).toBe(
      'Automatic backup · 2026-10-17 09:49 · saved before importing a.json'
    )
    expect(reviewSubtitle({ ...file, identical: false, backup: { savedAt: at } })).toBe(
      'Automatic backup · 2026-10-17 09:49 · saved before an import'
    )
    expect(reviewSubtitle({ ...file, identical: false })).toBe('f.json')
    expect(applyLabel(preview, 1)).toBe('Restore 1 section')
    expect(applyLabel({}, 2)).toBe('Apply 2 sections')
    expect(importDoneText(2, false)).toBe('Applied 2 sections')
    expect(restoreDoneText(at, true)).toBe(
      'Restored the backup from 2026-10-17 09:49 · the setup before it was backed up first'
    )
    expect(restoreDoneText(at, false)).toBe('Restored the backup from 2026-10-17 09:49')
  })
})
