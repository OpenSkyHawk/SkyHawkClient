import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_MAPPING, importMapping } from '@shared/node-mapping'
import type { NodeMappingFile } from '@shared/nodes/ipc'
import { storePaths } from '../app/user-data'

const userData = vi.hoisted(() => ({ dir: '' }))
// <userData> is handed in the way app hands it in (the store no longer asks electron, P6).
const paths = storePaths(() => userData.dir)

const store = await import('./mapping-store')
const { MappingSaveError } = store
const loadNodeMapping = () => store.loadNodeMapping(paths)
const saveNodeMapping = (f: NodeMappingFile) => store.saveNodeMapping(f, paths)

const file = (): string => join(userData.dir, 'node-mapping.json')
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
      nodes: { 1: { name: 'Armament' }, 2: { hidden: true } } // no `added`: not in this cockpit
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
    expect(loadNodeMapping()).toEqual({ file: { version: 3, nodes: {} } })
    const bad = readdirSync(userData.dir).filter((f) => f.startsWith('node-mapping.json.bad-'))
    expect(bad).toHaveLength(1)
    expect(readFileSync(join(userData.dir, bad[0]!), 'utf8')).toContain('"Arm')
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
