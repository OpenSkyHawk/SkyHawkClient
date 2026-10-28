// #173: where the Gateway's update drive is looked for on each OS, how it is recognised, and the
// copy: a plain write in pieces, the drive going away after the last byte counted as success.
import { describe, expect, it } from 'vitest'
import { driveRoots, uf2Drive, type DriveFs } from './uf2-drive'

const INFO = 'UF2 Bootloader v3.0\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n'

/** A file system with `files` readable, recording what is written. */
function fakeFs(files: Record<string, string>, failAfter?: number, failOnSync = false) {
  const written: { path: string; bytes: number[] }[] = []
  const fs: DriveFs = {
    readText: (path) => Promise.resolve(files[path]),
    // A folder's entries: the next path segment of every file under it.
    list: (dir) =>
      Promise.resolve([
        ...new Set(
          Object.keys(files)
            .filter((f) => f.startsWith(`${dir}/`))
            .map((f) => f.slice(dir.length + 1).split('/')[0]!)
        )
      ]),
    open: (path) => {
      const w = { path, bytes: [] as number[] }
      written.push(w)
      return Promise.resolve({
        write: (chunk: Uint8Array) => {
          if (failAfter !== undefined && w.bytes.length + chunk.length > failAfter) {
            return Promise.reject(new Error('EIO'))
          }
          w.bytes.push(...chunk)
          return Promise.resolve()
        },
        sync: () => (failOnSync ? Promise.reject(new Error('ENOENT')) : Promise.resolve()),
        close: () => Promise.resolve()
      })
    }
  }
  return { fs, written }
}

describe('the update drive (#173)', () => {
  it('is looked for where each OS mounts it', () => {
    expect(driveRoots('darwin', 'pat')).toEqual({ parents: ['/Volumes'] })
    expect(driveRoots('linux', 'pat')).toEqual({ parents: ['/media/pat', '/run/media/pat'] })
    const win = driveRoots('win32', 'pat') as { letters: string[] }
    expect(win.letters[0]).toBe('D:\\')
    expect(win.letters.at(-1)).toBe('Z:\\')
  })

  it('lists every drive whose INFO_UF2.TXT names an RP2040 boot ROM, a second one included', async () => {
    // macOS names a second drive with the same label `RPI-RP2 1`.
    const mac = uf2Drive(
      { platform: 'darwin', user: 'pat' },
      fakeFs({
        '/Volumes/RPI-RP2/INFO_UF2.TXT': INFO,
        '/Volumes/RPI-RP2 1/INFO_UF2.TXT': INFO,
        '/Volumes/Backup/INFO_UF2.TXT': INFO,
        '/Volumes/RPI-RP2 copy/notes.txt': 'x'
      }).fs
    )
    expect(await mac.list()).toEqual(['/Volumes/RPI-RP2', '/Volumes/RPI-RP2 1'])
    const linux = uf2Drive(
      { platform: 'linux', user: 'pat' },
      fakeFs({ '/run/media/pat/RPI-RP2/INFO_UF2.TXT': INFO }).fs
    )
    expect(await linux.list()).toEqual(['/run/media/pat/RPI-RP2'])
    // Windows: the letters that carry it; another UF2 board's drive doesn't count.
    const win = uf2Drive(
      { platform: 'win32', user: 'pat' },
      fakeFs({ 'E:\\INFO_UF2.TXT': 'Board-ID: SOMETHING-ELSE', 'G:\\INFO_UF2.TXT': INFO }).fs
    )
    expect(await win.list()).toEqual(['G:\\'])
    expect(await uf2Drive({ platform: 'darwin', user: 'pat' }, fakeFs({}).fs).list()).toEqual([])
  })

  it('copies in pieces with progress; the drive going after the last byte is success', async () => {
    const bytes = new Uint8Array(40 * 1024).map((_, i) => i & 0xff)
    const ok = fakeFs({})
    const pct: number[] = []
    expect(
      await uf2Drive({ platform: 'darwin', user: 'pat' }, ok.fs).write(
        '/Volumes/RPI-RP2',
        'g.uf2',
        bytes,
        (n) => pct.push(n)
      )
    ).toBe(true)
    expect(ok.written[0]!.path).toBe('/Volumes/RPI-RP2/g.uf2')
    expect(ok.written[0]!.bytes).toEqual([...bytes])
    expect(pct).toEqual([40, 80, 100])
    // The board restarts as the last block lands: the flush finds no drive.
    const gone = fakeFs({}, undefined, true)
    expect(
      await uf2Drive({ platform: 'darwin', user: 'pat' }, gone.fs).write(
        '/Volumes/RPI-RP2',
        'g.uf2',
        bytes,
        () => {}
      )
    ).toBe(true)
  })

  it('the drive going away mid-copy is a failed copy', async () => {
    const cut = fakeFs({}, 20 * 1024)
    const bytes = new Uint8Array(40 * 1024)
    expect(
      await uf2Drive({ platform: 'darwin', user: 'pat' }, cut.fs).write(
        '/Volumes/RPI-RP2',
        'g.uf2',
        bytes,
        () => {}
      )
    ).toBe(false)
  })
})
