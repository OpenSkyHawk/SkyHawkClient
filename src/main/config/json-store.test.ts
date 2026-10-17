// The JSON store's mechanics (#136, D5 / M6 + X13): one set of write and read rules for every file
// under <userData>. The file system is the real one, in a temporary folder, seen through a
// recording wrapper so the order of the durable-write steps is observable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { jsonFile, type JsonFs } from './json-store'

let dir = ''
const file = (): string => join(dir, 'store.json')
const text = (v: unknown): string => JSON.stringify(v, null, 2)
const onDisk = (name: string): string => readFileSync(join(dir, name), 'utf8')
const listing = (): string[] => readdirSync(dir).sort()
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: test`), { code })

/** node:fs, recording each call as `op name` (fds named by the path they were opened on). */
function recordingFs(overrides: Partial<JsonFs> = {}) {
  const ops: string[] = []
  const fdName = new Map<number, string>()
  const name = (p: fs.PathLike | number): string =>
    typeof p === 'number' ? (fdName.get(p) ?? `fd${p}`) : basename(String(p)) || String(p)
  const real: JsonFs = {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: (f, data) => {
      ops.push(`write ${name(f as number)}`)
      fs.writeFileSync(f, data)
    },
    openSync: (p, flags) => {
      const fd = fs.openSync(p, flags)
      fdName.set(fd, String(p) === dir ? '<dir>' : name(p))
      ops.push(`open ${fdName.get(fd)}`)
      return fd
    },
    fsyncSync: (fd) => {
      ops.push(`fsync ${name(fd)}`)
      fs.fsyncSync(fd)
    },
    closeSync: (fd) => {
      ops.push(`close ${name(fd)}`)
      fs.closeSync(fd)
    },
    renameSync: (from, to) => {
      ops.push(`rename ${name(from)} -> ${name(to)}`)
      fs.renameSync(from, to)
    },
    rmSync: (p, o) => {
      ops.push(`rm ${name(p)}`)
      fs.rmSync(p, o)
    }
  }
  return { ops, fs: { ...real, ...overrides } as JsonFs }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skyhawk-json-store-'))
})
afterEach(() => {
  fs.chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

describe('a write', () => {
  it('writes the temp file, fsyncs it, renames it over the file, then fsyncs the folder', () => {
    const rec = recordingFs()
    expect(jsonFile(file, { fs: rec.fs, platform: 'darwin' }).write({ a: 1 })).toBeUndefined()
    expect(rec.ops).toEqual([
      'open store.json.tmp',
      'write store.json.tmp',
      'fsync store.json.tmp',
      'close store.json.tmp',
      'rename store.json.tmp -> store.json',
      'open <dir>',
      'fsync <dir>',
      'close <dir>'
    ])
    expect(onDisk('store.json')).toBe(text({ a: 1 }))
    expect(listing()).toEqual(['store.json']) // nothing to back up yet, no temp file left
  })

  it('keeps the file it replaces as .bak first, by the same durable steps', () => {
    writeFileSync(file(), text({ a: 1 }))
    const rec = recordingFs()
    jsonFile(file, { fs: rec.fs, platform: 'linux' }).write({ a: 2 })
    expect(rec.ops).toEqual([
      'open store.json.bak.tmp',
      'write store.json.bak.tmp',
      'fsync store.json.bak.tmp',
      'close store.json.bak.tmp',
      'rename store.json.bak.tmp -> store.json.bak',
      'open <dir>',
      'fsync <dir>',
      'close <dir>',
      'open store.json.tmp',
      'write store.json.tmp',
      'fsync store.json.tmp',
      'close store.json.tmp',
      'rename store.json.tmp -> store.json',
      'open <dir>',
      'fsync <dir>',
      'close <dir>'
    ])
  })

  it('rotates .bak: it always holds the version before the last write', () => {
    const f = jsonFile(file)
    f.write({ v: 1 })
    f.write({ v: 2 })
    expect(onDisk('store.json.bak')).toBe(text({ v: 1 }))
    f.write({ v: 3 })
    expect(onDisk('store.json.bak')).toBe(text({ v: 2 }))
    expect(onDisk('store.json')).toBe(text({ v: 3 }))
    expect(listing()).toEqual(['store.json', 'store.json.bak'])
  })

  it('never backs up a file that does not parse: .bak keeps the last version that did', () => {
    const f = jsonFile(file)
    f.write({ v: 1 })
    f.write({ v: 2 }) // .bak = v1
    writeFileSync(file(), '{"v":') // damaged under the app
    f.write({ v: 3 })
    expect(onDisk('store.json.bak')).toBe(text({ v: 1 }))
    expect(onDisk('store.json')).toBe(text({ v: 3 }))
  })

  it('fails without replacing the file when the backup cannot be written', () => {
    writeFileSync(file(), text({ v: 1 }))
    mkdirSync(join(dir, 'store.json.bak')) // a folder: the rename over it fails
    const failed = jsonFile(file).write({ v: 2 })
    expect(failed?.note).toMatch(/^store\.json could not be saved: /)
    expect(onDisk('store.json')).toBe(text({ v: 1 }))
    expect(listing()).toEqual(['store.json', 'store.json.bak']) // no temp file left behind
  })

  it('reports a failed write with a note, and removes its temp file', () => {
    const rec = recordingFs({
      renameSync: () => {
        throw errno('EACCES')
      }
    })
    const failed = jsonFile(file, { fs: rec.fs }).write({ a: 1 })
    expect(failed).toEqual({
      error: expect.objectContaining({ code: 'EACCES' }),
      note: 'store.json could not be saved: EACCES: test'
    })
    expect(rec.ops.at(-1)).toBe('rm store.json.tmp')
    expect(listing()).toEqual([])
  })

  it('throws when the path cannot be resolved', () => {
    const broken = jsonFile(() => {
      throw new Error('no userData')
    })
    expect(() => broken.write({})).toThrow('no userData')
    expect(() => broken.read()).toThrow('no userData')
  })

  describe('the folder fsync', () => {
    it('is skipped on Windows, where a folder cannot be opened', () => {
      const rec = recordingFs()
      expect(jsonFile(file, { fs: rec.fs, platform: 'win32' }).write({ a: 1 })).toBeUndefined()
      expect(rec.ops.filter((o) => o.includes('<dir>'))).toEqual([])
      expect(rec.ops.at(-1)).toBe('rename store.json.tmp -> store.json')
    })

    it.each(['EPERM', 'EISDIR', 'EINVAL'])(
      'ignores %s opening the folder (a Windows-style refusal): the write stands',
      (code) => {
        const rec = recordingFs({
          openSync: (p, flags) => {
            if (String(p) === dir) throw errno(code)
            return fs.openSync(p, flags)
          }
        })
        expect(jsonFile(file, { fs: rec.fs, platform: 'linux' }).write({ a: 1 })).toBeUndefined()
        expect(onDisk('store.json')).toBe(text({ a: 1 }))
      }
    )

    it('ignores EPERM from the fsync itself, and still closes the folder', () => {
      let dirFd = -1
      const rec = recordingFs({
        openSync: (p, flags) => {
          const fd = fs.openSync(p, flags)
          if (String(p) === dir) dirFd = fd
          return fd
        },
        fsyncSync: (fd) => {
          if (fd === dirFd) throw errno('EPERM')
          fs.fsyncSync(fd)
        }
      })
      expect(jsonFile(file, { fs: rec.fs, platform: 'darwin' }).write({ a: 1 })).toBeUndefined()
      expect(rec.ops.at(-1)).toBe(`close fd${dirFd}`)
    })

    it('reports any other folder fsync failure: the save may not have reached the disk', () => {
      const rec = recordingFs({
        openSync: (p, flags) => {
          if (String(p) === dir) throw errno('EIO')
          return fs.openSync(p, flags)
        }
      })
      expect(jsonFile(file, { fs: rec.fs, platform: 'linux' }).write({ a: 1 })?.note).toBe(
        'store.json could not be saved: EIO: test'
      )
    })
  })
})

describe('a read', () => {
  it('reads a missing file as missing, and a good one as its data, touching nothing', () => {
    expect(jsonFile(file).read()).toEqual({ kind: 'missing' })
    writeFileSync(file(), '{"a":1}')
    writeFileSync(join(dir, 'store.json.bak'), '{"a":0}')
    expect(jsonFile(file).read()).toEqual({ kind: 'read', data: { a: 1 } })
    expect(listing()).toEqual(['store.json', 'store.json.bak'])
  })

  it('a missing file is missing even with a backup: .bak only stands in for a bad file', () => {
    writeFileSync(join(dir, 'store.json.bak'), '{"a":0}')
    expect(jsonFile(file).read()).toEqual({ kind: 'missing' })
  })

  it('a damaged file falls back to .bak, is moved aside, and the backup is put back', () => {
    writeFileSync(file(), '{"a":')
    writeFileSync(join(dir, 'store.json.bak'), '{"a":0}')
    const r = jsonFile(file).read()
    const bad = listing().find((f) => f.startsWith('store.json.bad-'))!
    expect(r).toEqual({
      kind: 'fallback',
      data: { a: 0 },
      damage: { kind: 'damaged' },
      aside: { kind: 'moved', to: join(dir, bad) },
      note: `store.json is damaged. Loaded the backup, store.json.bak. The bad copy was kept as ${bad}.`
    })
    expect(onDisk(bad)).toBe('{"a":')
    expect(onDisk('store.json')).toBe('{"a":0}') // the next read finds the good copy
    expect(onDisk('store.json.bak')).toBe('{"a":0}')
    expect(jsonFile(file).read()).toEqual({ kind: 'read', data: { a: 0 } })
  })

  it('a file that cannot be read (here a folder) falls back to .bak too', () => {
    mkdirSync(file())
    writeFileSync(join(dir, 'store.json.bak'), '{"a":0}')
    const r = jsonFile(file).read()
    expect(r.kind).toBe('fallback')
    if (r.kind !== 'fallback') return
    expect(r.damage).toEqual({
      kind: 'unreadable',
      error: expect.objectContaining({ code: 'EISDIR' })
    })
    expect(r.note).toMatch(
      /^store\.json could not be read \(EISDIR: .*\)\. Loaded the backup, store\.json\.bak\. The bad copy was kept as store\.json\.bad-.*\.$/
    )
    expect(onDisk('store.json')).toBe('{"a":0}')
  })

  it.skipIf(process.getuid?.() === 0)(
    'a bad file that cannot be moved aside still loads the backup, and says it is stuck',
    () => {
      writeFileSync(file(), '{"a":')
      writeFileSync(join(dir, 'store.json.bak'), '{"a":0}')
      fs.chmodSync(dir, 0o500) // read-only folder: no rename
      const r = jsonFile(file).read()
      expect(r).toMatchObject({ kind: 'fallback', data: { a: 0 }, aside: { kind: 'stuck' } })
      expect(r.kind === 'fallback' && r.note).toMatch(
        /^store\.json is damaged\. Loaded the backup, store\.json\.bak\. The bad copy could not be moved aside \(EACCES: .*\)\.$/
      )
      expect(onDisk('store.json')).toBe('{"a":')
    }
  )

  describe('double damage: the file and its backup', () => {
    it('damaged, no backup: nothing loads, the file is moved aside', () => {
      writeFileSync(file(), '{"a":')
      const r = jsonFile(file).read()
      const bad = listing().find((f) => f.startsWith('store.json.bad-'))!
      expect(r).toEqual({
        kind: 'failed',
        damage: { kind: 'damaged' },
        backup: 'missing',
        aside: { kind: 'moved', to: join(dir, bad) },
        note: `store.json is damaged, and there is no backup. The bad copy was kept as ${bad}.`
      })
      expect(listing()).toEqual([bad])
    })

    it('damaged, backup damaged too', () => {
      writeFileSync(file(), '{"a":')
      writeFileSync(join(dir, 'store.json.bak'), '{"a"')
      const r = jsonFile(file).read()
      expect(r).toMatchObject({ kind: 'failed', backup: { kind: 'damaged' } })
      expect(r.kind === 'failed' && r.note).toMatch(
        /^store\.json is damaged, and its backup is damaged too\. The bad copy was kept as /
      )
      expect(onDisk('store.json.bak')).toBe('{"a"') // the backup is left as it is
    })

    it('unreadable, no backup: the file is left in place for the next read to try again', () => {
      mkdirSync(file())
      const r = jsonFile(file).read()
      expect(r).toMatchObject({ kind: 'failed', backup: 'missing', aside: { kind: 'left' } })
      expect(r.kind === 'failed' && r.note).toMatch(
        /^store\.json could not be read \(EISDIR: .*\), and there is no backup\.$/
      )
      expect(listing()).toEqual(['store.json'])
    })

    it('damaged, backup unreadable', () => {
      writeFileSync(file(), '{"a":')
      mkdirSync(join(dir, 'store.json.bak'))
      const r = jsonFile(file).read()
      expect(r).toMatchObject({ kind: 'failed', backup: { kind: 'unreadable' } })
      expect(r.kind === 'failed' && r.note).toMatch(
        /^store\.json is damaged, and its backup could not be read either \(EISDIR: .*\)\./
      )
    })
  })
})

describe('a copy (snapshot / restore: an import rollback, C2/M10)', () => {
  it('puts the file and its .bak back byte for byte, undoing the writes since', () => {
    // Bytes no write of the store would produce: a restore is not a re-serialisation.
    writeFileSync(file(), '{"a":1}\n')
    writeFileSync(`${file()}.bak`, '{ "a": 0 }')
    const store = jsonFile(file)
    const copy = store.snapshot()
    store.write({ a: 2 })
    store.write({ a: 3 })
    expect(onDisk('store.json.bak')).toBe(text({ a: 2 })) // rotated by the writes
    expect(store.restore(copy)).toBeUndefined()
    expect(onDisk('store.json')).toBe('{"a":1}\n')
    expect(onDisk('store.json.bak')).toBe('{ "a": 0 }')
    expect(listing()).toEqual(['store.json', 'store.json.bak'])
  })

  it('removes what did not exist when the copy was taken', () => {
    const store = jsonFile(file)
    const copy = store.snapshot()
    expect(copy).toEqual({ file: null, bak: null })
    store.write({ a: 1 })
    store.write({ a: 2 })
    expect(store.restore(copy)).toBeUndefined()
    expect(listing()).toEqual([])
  })

  it('restores by the durable steps: temp file, fsync, rename, folder fsync', () => {
    writeFileSync(file(), text({ a: 1 }))
    const copy = jsonFile(file).snapshot()
    const rec = recordingFs()
    expect(jsonFile(file, { fs: rec.fs, platform: 'darwin' }).restore(copy)).toBeUndefined()
    expect(rec.ops).toEqual([
      'rm store.json.bak',
      'open <dir>',
      'fsync <dir>',
      'close <dir>',
      'open store.json.tmp',
      'write store.json.tmp',
      'fsync store.json.tmp',
      'close store.json.tmp',
      'rename store.json.tmp -> store.json',
      'open <dir>',
      'fsync <dir>',
      'close <dir>'
    ])
  })

  it.skipIf(process.getuid?.() === 0)('a restore that cannot reach the disk says so', () => {
    writeFileSync(file(), text({ a: 1 }))
    const store = jsonFile(file)
    const copy = store.snapshot()
    store.write({ a: 2 })
    fs.chmodSync(dir, 0o500)
    const failed = store.restore(copy)
    expect(failed?.note).toMatch(/^store\.json could not be put back: EACCES/)
  })

  it('a file that exists but cannot be read cannot be copied: the snapshot throws', () => {
    mkdirSync(file()) // a folder where the file should be
    expect(() => jsonFile(file).snapshot()).toThrow(/EISDIR/)
  })
})
