// BackupFolder against a real folder (#136): a backup is written, ours beyond the newest five are
// deleted and nothing else in the folder is touched, the list is newest first, a restore reads
// only one of ours, and every change to the list is pushed.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type BackupList } from '@shared/config'
import { BackupFolder } from './backup-folder'
import { backupFileName } from './backups'
import { appSettings } from './config-file'

let root: string
let dir: string
let pushes: BackupList[]

const folder = () =>
  new BackupFolder({
    dir: () => dir,
    emit: (_channel, list) => void pushes.push(list),
    platform: 'darwin'
  })

/** A backup's text: the app section, and what it was saved before. */
const text = (fileName: string) =>
  JSON.stringify({
    format: CONFIG_FORMAT,
    version: 1,
    sections: { app: appSettings(DEFAULT_CONFIG) },
    backup: { before: { kind: 'import', fileName } }
  })

/** `n` minutes after 2026-10-16 10:00 UTC. */
const at = (n: number) => new Date(Date.UTC(2026, 9, 16, 10, n))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skyhawk-backups-'))
  dir = join(root, 'backups')
  pushes = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('BackupFolder (#136)', () => {
  it('no folder yet: no backups', () => {
    expect(folder().list()).toEqual({ backups: [], keep: 5, fileManager: 'finder' })
  })

  it('writes a backup, creating the folder, and pushes the list', () => {
    const path = folder().save(text('a.json'), at(0))
    expect(path).toBe(join(dir, 'skyhawk-config-2026-10-16T10-00-00-000Z.json'))
    expect(readFileSync(path, 'utf8')).toBe(text('a.json'))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.backups).toEqual([
      {
        file: 'skyhawk-config-2026-10-16T10-00-00-000Z.json',
        savedAt: '2026-10-16T10:00:00.000Z',
        before: { kind: 'import', fileName: 'a.json' },
        sections: ['App settings']
      }
    ])
  })

  it('lists newest first', () => {
    const f = folder()
    for (const n of [3, 0, 4, 1, 2]) f.save(text(`file-${n}.json`), at(n))
    expect(f.list().backups.map((b) => b.before)).toEqual(
      [4, 3, 2, 1, 0].map((n) => ({ kind: 'import', fileName: `file-${n}.json` }))
    )
  })

  it('keeps the newest five: the oldest are deleted after a new one, nothing else is', () => {
    mkdirSync(dir)
    // Not ours, whatever they look like: an export saved here, a note, a folder named like one.
    const others = ['skyhawk-config-2026-10-16.json', 'notes.txt', 'skyhawk-config-x.json']
    for (const name of others) writeFileSync(join(dir, name), 'keep me')
    mkdirSync(join(dir, 'old'))
    writeFileSync(join(dir, 'old', backupFileName(at(-60))), 'keep me')
    // Seven of ours from earlier (an older client did not delete any).
    for (let n = 0; n < 7; n++) writeFileSync(join(dir, backupFileName(at(n))), text(`${n}.json`))

    folder().save(text('new.json'), at(10))

    const ours = [10, 6, 5, 4, 3].map((n) => backupFileName(at(n)))
    expect(readdirSync(dir).sort()).toEqual([...others, 'old', ...ours].sort())
    for (const name of others) expect(readFileSync(join(dir, name), 'utf8')).toBe('keep me')
    expect(existsSync(join(dir, 'old', backupFileName(at(-60))))).toBe(true)
    expect(pushes.at(-1)!.backups.map((b) => b.file)).toEqual(ours)
  })

  it('a backup that cannot be written throws, and deletes nothing', () => {
    mkdirSync(dir)
    for (let n = 0; n < 5; n++) writeFileSync(join(dir, backupFileName(at(n))), text(`${n}.json`))
    // The new backup's name is taken by a folder: the write fails.
    mkdirSync(join(dir, backupFileName(at(9))))
    expect(() => folder().save(text('new.json'), at(9))).toThrow()
    expect(readdirSync(dir)).toHaveLength(6)
    expect(pushes).toEqual([])
  })

  it('a restore reads one of ours, and nothing else', () => {
    const f = folder()
    f.save(text('a.json'), at(0))
    const name = backupFileName(at(0))
    expect(f.read(name)).toEqual({
      ok: true,
      file: name,
      text: text('a.json'),
      savedAt: '2026-10-16T10:00:00.000Z'
    })
    writeFileSync(join(root, 'config.json'), '{}')
    for (const file of ['../config.json', 'notes.txt', `../backups/${name}`, 7, undefined]) {
      expect(f.read(file)).toEqual({ ok: false, error: 'Invalid backup request' })
    }
  })

  it('a backup deleted since the list was pushed: says so, and pushes the list again', () => {
    const f = folder()
    f.save(text('a.json'), at(0))
    rmSync(join(dir, backupFileName(at(0))))
    pushes = []
    expect(f.read(backupFileName(at(0)))).toEqual({
      ok: false,
      error: 'This backup is no longer in the backups folder.'
    })
    expect(pushes).toEqual([{ backups: [], keep: 5, fileManager: 'finder' }])
  })

  it('names the file manager by platform', () => {
    const list = (platform: string) => new BackupFolder({ dir: () => dir, platform }).list()
    expect(list('win32').fileManager).toBe('explorer')
    expect(list('linux').fileManager).toBe('folder')
  })
})
