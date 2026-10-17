import { describe, expect, it } from 'vitest'
import { CONFIG_FORMAT, DEFAULT_CONFIG } from '@shared/config'
import { DEFAULT_PSU } from '@shared/nodes'
import {
  BACKUP_KEEP,
  backupEntry,
  backupFileName,
  backupSavedAt,
  beyondKeep,
  fileManager,
  isBackupName,
  newestFirst
} from './backups'
import { appSettings } from './config-file'

/** A backup's name for a UTC time. */
const named = (iso: string) => backupFileName(new Date(iso))

describe('backup names (#136)', () => {
  it('a backup is named by its UTC time, and the time is read back from the name', () => {
    const name = named('2026-10-16T10:00:00.000Z')
    expect(name).toBe('skyhawk-config-2026-10-16T10-00-00-000Z.json')
    expect(backupSavedAt(name)).toBe('2026-10-16T10:00:00.000Z')
  })

  it('only a name this feature writes is a backup: never an export, a path or anything else', () => {
    for (const name of [
      'skyhawk-config-2026-10-16.json', // an export's default name
      'skyhawk-config-2026-10-16T10-00-00-000Z.json.bak',
      'skyhawk-config-2026-10-16T10-00-00-000Z.JSON',
      'my-skyhawk-config-2026-10-16T10-00-00-000Z.json',
      '../skyhawk-config-2026-10-16T10-00-00-000Z.json',
      'sub/skyhawk-config-2026-10-16T10-00-00-000Z.json',
      'skyhawk-config-2026-13-45T99-00-00-000Z.json', // not a time
      'notes.txt',
      ''
    ]) {
      expect(isBackupName(name), name).toBe(false)
    }
  })
})

describe('which backups are listed and kept (#136)', () => {
  const times = [
    '2026-10-09T08:40:00.000Z',
    '2026-10-17T09:49:00.000Z',
    '2026-10-12T21:05:00.000Z',
    '2025-12-31T23:59:59.999Z',
    '2026-10-16T22:14:00.000Z',
    '2026-10-15T19:03:00.000Z',
    '2026-10-17T09:48:59.999Z'
  ]
  const others = ['notes.txt', 'skyhawk-config-2026-10-16.json', '.DS_Store']

  it('lists ours newest first, and nothing else in the folder', () => {
    expect(newestFirst([...others, ...times.map(named)])).toEqual(
      [...times].sort().reverse().map(named)
    )
  })

  it('keeps the newest five: only ours beyond them are deleted, never anything else', () => {
    expect(BACKUP_KEEP).toBe(5)
    expect(beyondKeep([...others, ...times.map(named)])).toEqual([
      named('2026-10-09T08:40:00.000Z'),
      named('2025-12-31T23:59:59.999Z')
    ])
    expect(beyondKeep([...others, ...times.slice(0, 5).map(named)])).toEqual([])
    expect(beyondKeep(others)).toEqual([])
  })
})

describe('a backup as the list shows it (#136)', () => {
  const name = named('2026-10-17T09:49:00.000Z')
  const file = (extra: Record<string, unknown>, sections: Record<string, unknown>) =>
    JSON.stringify({ format: CONFIG_FORMAT, version: 1, sections, ...extra })
  const all = {
    app: appSettings(DEFAULT_CONFIG),
    nodeMapping: { version: 3, nodes: {} },
    powerSupply: DEFAULT_PSU,
    calibration: { version: 1, boards: {} }
  }

  it('says what it was saved before and which sections it holds, from inside the file', () => {
    const before = { kind: 'import', fileName: 'cockpit-left-only.json' } as const
    expect(backupEntry(name, file({ backup: { before } }, all))).toEqual({
      file: name,
      savedAt: '2026-10-17T09:49:00.000Z',
      before,
      sections: ['App settings', 'Node mapping', 'Power supply', 'Axis calibration']
    })
    const restore = { kind: 'restore', savedAt: '2026-10-16T22:14:00.000Z' } as const
    expect(
      backupEntry(name, file({ backup: { before: restore } }, { nodeMapping: all.nodeMapping }))
    ).toMatchObject({ before: restore, sections: ['Node mapping'] })
  })

  it('a backup from before backups said so still lists, with no record of what it was before', () => {
    const entry = backupEntry(name, file({}, all))
    expect(entry).not.toHaveProperty('before')
    expect(entry.sections).toHaveLength(4)
  })

  it('a backup that cannot be read still lists, by its time', () => {
    for (const text of [undefined, '{ nope', '{}']) {
      expect(backupEntry(name, text)).toEqual({
        file: name,
        savedAt: '2026-10-17T09:49:00.000Z',
        sections: []
      })
    }
  })
})

describe('the file manager the folder opens in', () => {
  it('Finder on macOS, Explorer on Windows, the desktop’s folder view elsewhere', () => {
    expect(fileManager('darwin')).toBe('finder')
    expect(fileManager('win32')).toBe('explorer')
    expect(fileManager('linux')).toBe('folder')
  })
})
