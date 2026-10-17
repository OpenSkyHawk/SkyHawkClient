import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_MAPPING, importMapping } from './mapping-rules'
import type { NodeMappingFile } from '@shared/nodes'
import { storeFiles, storePaths } from '../app/user-data'
import { MappingStore, type MappingFileEvents, type MappingFileIO } from './mapping-store'

const userData = vi.hoisted(() => ({ dir: '' }))
// <userData> is handed in the way app hands it in (the store no longer asks electron, P6), as the
// node-mapping.json port app wires (the JSON store, under its one set of rules).
const io = storeFiles(storePaths(() => userData.dir)).mappingFile

const store = await import('./mapping-file')
const { MappingSaveError } = store
const loadNodeMapping = () => store.loadNodeMapping(io)
const saveNodeMapping = (f: NodeMappingFile) => store.saveNodeMapping(f, io)

const file = (): string => join(userData.dir, 'node-mapping.json')
const bak = (): string => join(userData.dir, 'node-mapping.json.bak')
const badCopy = (): string | undefined =>
  readdirSync(userData.dir).find((f) => f.startsWith('node-mapping.json.bad-'))

/** The event log as node-mapping.json reports to it, deduped per tag as EventJournal.error is. */
function eventLog() {
  const rows: string[] = []
  const last = new Map<string, string>()
  /** `<severity> <tag>: <message>`, deduped per tag across both severities. */
  const add = (severity: string, tag: string, msg: string) => {
    if (last.get(tag) === msg) return
    last.set(tag, msg)
    rows.push(`${severity} ${tag}: ${msg}`)
  }
  const events: MappingFileEvents = {
    error: (tag, msg) => add('error', tag, msg),
    warn: (tag, msg) => add('warn', tag, msg),
    forget: (tag) => last.delete(tag)
  }
  return { rows, events }
}
const sample: NodeMappingFile = {
  version: 3,
  nodes: {
    1: { name: 'Armament', lastSeen: '2026-10-14T21:14:00.000Z', added: true },
    41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
  }
}

describe('node-mapping.json', () => {
  // #93 re-review E: a fresh computer imports a config — nothing is in its cockpit — then restarts.
  it('a v3 file is read as written: an import never adds boards on the next load', () => {
    const imported: NodeMappingFile = {
      version: 3,
      // No `added`: not in this cockpit. (A pre-v3 file would read both as added.)
      nodes: { 1: { name: 'Armament' }, 2: { console: 'Left' } }
    }
    saveNodeMapping(importMapping(EMPTY_MAPPING, imported))
    expect(loadNodeMapping().file).toEqual(imported) // after the restart: still not added
  })

  beforeEach(() => {
    userData.dir = mkdtempSync(join(tmpdir(), 'skyhawk-mapping-'))
  })
  afterEach(() => {
    chmodSync(userData.dir, 0o700)
    rmSync(userData.dir, { recursive: true, force: true })
  })

  it('a missing file loads as an empty, writable mapping', () => {
    expect(loadNodeMapping()).toEqual({ file: { version: 3, nodes: {} } })
  })

  it('round-trips, writing atomically (no temp file left behind)', () => {
    saveNodeMapping(sample)
    expect(readdirSync(userData.dir)).toEqual(['node-mapping.json'])
    expect(loadNodeMapping()).toEqual({ file: sample })
  })

  it('moves a damaged file aside instead of letting the next save overwrite it', () => {
    writeFileSync(file(), '{"version":1,"nodes":{"1":{"name":"Arm')
    const loaded = loadNodeMapping()
    const bad = readdirSync(userData.dir).filter((f) => f.startsWith('node-mapping.json.bad-'))
    expect(bad).toHaveLength(1)
    expect(readFileSync(join(userData.dir, bad[0]!), 'utf8')).toContain('"Arm')
    // No backup to load: an empty, writable cockpit, and a notice for the event log.
    expect(loaded).toEqual({
      file: { version: 3, nodes: {} },
      notice: {
        severity: 'error',
        text:
          `node-mapping.json is damaged, and there is no backup. The bad copy was kept as ` +
          `${bad[0]}. Starting with an empty cockpit.`
      }
    })
  })

  it('a damaged file falls back to node-mapping.json.bak: the cockpit comes back, writable', () => {
    saveNodeMapping(sample)
    saveNodeMapping({ ...sample, nodes: {} }) // .bak = sample
    writeFileSync(file(), '{"version":3,"nodes":{"1":{"name":"Arm')
    expect(loadNodeMapping()).toEqual({
      file: sample,
      // Nothing lost: a warn row.
      notice: {
        severity: 'warn',
        text:
          `node-mapping.json is damaged. Loaded the backup, node-mapping.json.bak. The bad copy ` +
          `was kept as ${badCopy()}.`
      }
    })
    expect(readFileSync(join(userData.dir, badCopy()!), 'utf8')).toContain('"Arm')
    expect(loadNodeMapping()).toEqual({ file: sample }) // the backup is back in place
  })

  it('a damaged file and a damaged backup: an empty cockpit, as with no backup', () => {
    writeFileSync(file(), '{"version":3,"nodes":{"1":{"name":"Arm')
    writeFileSync(bak(), '{"version":3,"no')
    expect(loadNodeMapping()).toEqual({
      file: { version: 3, nodes: {} },
      notice: {
        severity: 'error',
        text:
          `node-mapping.json is damaged, and its backup is damaged too. The bad copy was kept as ` +
          `${badCopy()}. Starting with an empty cockpit.`
      }
    })
  })

  it('an unreadable file with no backup is read-only and left in place, to be tried again', () => {
    mkdirSync(file()) // a folder: EISDIR
    const loaded = loadNodeMapping()
    expect(loaded.file).toEqual({ version: 3, nodes: {} })
    expect(loaded.readOnly).toMatch(/^node-mapping\.json could not be read: EISDIR: /)
    expect(loaded.retry).toBe(true)
    expect(loaded.notice?.severity).toBe('error')
    expect(loaded.notice?.text).toMatch(
      /^node-mapping\.json could not be read \(EISDIR: .*\), and there is no backup\. Cockpit changes are not saved until it can be loaded\.$/
    )
    expect(readdirSync(userData.dir)).toEqual(['node-mapping.json'])
  })

  it("a newer client's file is never replaced by the backup: valid, not damaged", () => {
    writeFileSync(file(), JSON.stringify({ ...sample, version: 4 }))
    writeFileSync(bak(), JSON.stringify({ version: 3, nodes: {} }))
    const before = readFileSync(file(), 'utf8')
    expect(loadNodeMapping()).toEqual({
      file: sample,
      readOnly: 'node-mapping.json was written by a newer client'
    })
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(readdirSync(userData.dir).sort()).toEqual(['node-mapping.json', 'node-mapping.json.bak'])
  })

  it('reads a v1 file (before #93) as v2: writable, its ignore list dropped', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, nodes: sample.nodes, ignored: [50] }))
    expect(loadNodeMapping()).toEqual({ file: sample })
  })

  it("loads a newer client's file read-only, so it is never rewritten as v3", () => {
    writeFileSync(file(), JSON.stringify({ ...sample, version: 4 }))
    expect(loadNodeMapping()).toEqual({
      file: sample,
      readOnly: 'node-mapping.json was written by a newer client'
    })
  })

  it.skipIf(process.getuid?.() === 0)('throws MappingSaveError when the write fails', () => {
    saveNodeMapping(sample)
    chmodSync(userData.dir, 0o500) // read-only userData
    expect(() => saveNodeMapping({ ...sample, nodes: {} })).toThrow(MappingSaveError)
    expect(() => saveNodeMapping({ ...sample, nodes: {} })).toThrow(
      /^Could not save node mapping: /
    )
    chmodSync(userData.dir, 0o700)
    expect(loadNodeMapping().file).toEqual(sample) // the old file is intact
  })
})

describe('MappingStore: a load that failed is tried again on the next access (M11)', () => {
  beforeEach(() => {
    userData.dir = mkdtempSync(join(tmpdir(), 'skyhawk-mapping-retry-'))
  })
  afterEach(() => {
    chmodSync(userData.dir, 0o700)
    rmSync(userData.dir, { recursive: true, force: true })
  })

  it('a refused save shows the reason; once the file reads, read-only clears', () => {
    mkdirSync(file()) // unreadable now, and no backup
    const log = eventLog()
    let commits = 0
    const ms = new MappingStore({ file: io, events: log.events, onCommit: () => commits++ })
    expect(ms.mapping()).toEqual({ version: 3, nodes: {} })
    expect(() => ms.save(sample)).toThrow(
      /^Not saved: node-mapping\.json could not be read: EISDIR/
    )
    expect(log.rows).toHaveLength(1) // retried on each access, reported once
    expect(log.rows[0]).toMatch(
      /^error node-mapping\.json: node-mapping\.json could not be read \(EISDIR/
    )

    // The trouble passes (no timer: nothing happens until the next access).
    rmSync(file(), { recursive: true })
    writeFileSync(file(), JSON.stringify(sample))
    expect(commits).toBe(0)
    expect(ms.mapping()).toEqual(sample) // the next read retries, and loads the file
    expect(commits).toBe(1) // the model is rebuilt from it
    ms.save({ ...sample, nodes: {} }) // writable again
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ ...sample, nodes: {} })
    expect(log.rows).toHaveLength(1)
  })

  it('the next save retries too, and the reason it shows is the latest one', () => {
    const results: ReturnType<MappingFileIO['read']>[] = [
      {
        kind: 'failed',
        damage: { kind: 'unreadable', error: new Error('EBUSY: one') },
        aside: { kind: 'left' },
        note: 'n1'
      },
      {
        kind: 'failed',
        damage: { kind: 'unreadable', error: new Error('EBUSY: two') },
        aside: { kind: 'left' },
        note: 'n2'
      },
      { kind: 'read', data: sample }
    ]
    const writes: NodeMappingFile[] = []
    const fake: MappingFileIO = {
      read: () => results.shift()!,
      write: (f) => {
        writes.push(f)
        return undefined
      }
    }
    const log = eventLog()
    const ms = new MappingStore({ file: fake, events: log.events })
    expect(ms.mapping()).toEqual({ version: 3, nodes: {} }) // first load: fails (n1)
    expect(() => ms.save(sample)).toThrow(
      'Not saved: node-mapping.json could not be read: EBUSY: two'
    )
    const next = { ...sample, nodes: { 7: { name: 'New' } } }
    ms.save(next) // third load reads the file: the save goes through
    expect(writes).toEqual([next])
    expect(ms.mapping()).toBe(next)
    expect(results).toEqual([]) // no further reads once loaded
    expect(log.rows.map((r) => r.replace(/^error node-mapping\.json: /, ''))).toEqual([
      'n1 Cockpit changes are not saved until it can be loaded.',
      'n2 Cockpit changes are not saved until it can be loaded.'
    ])
  })

  it('reports a backup that loaded at warn, and one stuck read-only at error', () => {
    type Fallback = Extract<ReturnType<MappingFileIO['read']>, { kind: 'fallback' }>
    const fallback = (aside: Fallback['aside']): Fallback => ({
      kind: 'fallback',
      data: sample,
      damage: { kind: 'damaged' },
      aside,
      note: 'restored'
    })
    const write = () => undefined
    const moved = eventLog()
    new MappingStore({
      file: { read: () => fallback({ kind: 'moved', to: 'x' }), write },
      events: moved.events
    }).mapping()
    expect(moved.rows).toEqual(['warn node-mapping.json: restored'])
    const stuck = eventLog()
    const ms = new MappingStore({
      file: { read: () => fallback({ kind: 'stuck', error: new Error('EACCES') }), write },
      events: stuck.events
    })
    expect(ms.mapping()).toEqual(sample) // the backup is shown…
    expect(() => ms.save({ ...sample, nodes: {} })).toThrow(
      'Not saved: node-mapping.json is damaged and could not be moved aside: EACCES'
    ) // …but nothing is saved over the bad file
    expect(stuck.rows).toEqual([
      'error node-mapping.json: restored Cockpit changes are not saved until it can be loaded.'
    ])
  })

  it("a newer client's file stays read-only and is not read again", () => {
    writeFileSync(file(), JSON.stringify({ ...sample, version: 4 }))
    let reads = 0
    const counting: MappingFileIO = {
      read: () => {
        reads++
        return io.read()
      },
      write: (f) => io.write(f)
    }
    const ms = new MappingStore({ file: counting })
    ms.mapping()
    expect(() => ms.save({ ...sample, nodes: {} })).toThrow(
      'Not saved: node-mapping.json was written by a newer client'
    )
    ms.mapping()
    expect(reads).toBe(1)
  })
})
