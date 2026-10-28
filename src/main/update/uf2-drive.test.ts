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
    expect(driveRoots('darwin', 'pat')).toEqual(['/Volumes/RPI-RP2'])
    expect(driveRoots('linux', 'pat')).toEqual(['/media/pat/RPI-RP2', '/run/media/pat/RPI-RP2'])
    const win = driveRoots('win32', 'pat')
    expect(win[0]).toBe('D:\\')
    expect(win.at(-1)).toBe('Z:\\')
  })

  it('is the one whose INFO_UF2.TXT names the RP2040 boot ROM', async () => {
    const mac = uf2Drive(
      { platform: 'darwin', user: 'pat' },
      fakeFs({ '/Volumes/RPI-RP2/INFO_UF2.TXT': INFO }).fs
    )
    expect(await mac.find()).toBe('/Volumes/RPI-RP2')
    // Windows: the first letter that carries it; another UF2 board's drive doesn't count.
    const win = uf2Drive(
      { platform: 'win32', user: 'pat' },
      fakeFs({ 'E:\\INFO_UF2.TXT': 'Board-ID: SOMETHING-ELSE', 'G:\\INFO_UF2.TXT': INFO }).fs
    )
    expect(await win.find()).toBe('G:\\')
    expect(await uf2Drive({ platform: 'linux', user: 'pat' }, fakeFs({}).fs).find()).toBeUndefined()
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
