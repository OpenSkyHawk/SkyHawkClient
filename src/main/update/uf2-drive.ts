// The Gateway's update drive (#173): where the RP2040's boot ROM mounts it on each OS, and the copy
// onto it. A blank RP2040 mounts it by itself; a running one is restarted into it by the 1200-baud
// touch (README-gateway.md:28-33).
//
// The copy is a plain write, never the system copy call: on macOS the system copy (fcopyfile, which
// fs.copyFile also uses) took 41 s on the bench, a plain write 1 s (OpenSkyhawk#361).
import { open, readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** The boot ROM's volume label: its Board-ID, in the info file at the drive's root. */
export const UF2_LABEL = 'RPI-RP2'
/** The boot ROM's info file at the drive's root; it names the board (`Board-ID: RPI-RP2`). */
export const UF2_INFO_FILE = 'INFO_UF2.TXT'

/** Written in pieces this big, for the copy's progress. */
const CHUNK = 16 * 1024

/** The update drive, as the update flow uses it. */
export interface Uf2Drive {
  /** Where the drive is mounted now, or undefined. */
  find(): Promise<string | undefined>
  /**
   * Write `bytes` as `name` at the drive's root. True when every byte went out: the board restarts
   * as the last block lands, so the drive going away after that is success, not a failure.
   */
  write(root: string, name: string, bytes: Uint8Array, pct: (n: number) => void): Promise<boolean>
}

/** Where the drive can be mounted on `platform`. Windows: every drive letter but A–C. */
export function driveRoots(platform: NodeJS.Platform, user: string): string[] {
  if (platform === 'darwin') return [`/Volumes/${UF2_LABEL}`]
  if (platform === 'win32') {
    return Array.from({ length: 23 }, (_, n) => `${String.fromCharCode(68 + n)}:\\`)
  }
  return [`/media/${user}/${UF2_LABEL}`, `/run/media/${user}/${UF2_LABEL}`]
}

/** The file operations the drive needs (node's, unless a test hands in its own). */
export interface DriveFs {
  readText(path: string): Promise<string | undefined>
  open(path: string): Promise<{
    write(chunk: Uint8Array): Promise<unknown>
    sync(): Promise<void>
    close(): Promise<void>
  }>
}

const NODE_FS: DriveFs = {
  readText: (path) => readFile(path, 'latin1').catch(() => undefined),
  open: (path) => open(path, 'w')
}

/** The drive on this computer: its OS's mount points, its info file naming an RP2040 boot ROM. */
export function uf2Drive(
  env: { platform: NodeJS.Platform; user: string },
  fs: DriveFs = NODE_FS
): Uf2Drive {
  const join = env.platform === 'win32' ? win32.join : posix.join
  return {
    async find() {
      for (const root of driveRoots(env.platform, env.user)) {
        const info = await fs.readText(join(root, UF2_INFO_FILE))
        if (info?.includes(UF2_LABEL)) return root
      }
      return undefined
    },
    async write(root, name, bytes, pct) {
      let written = 0
      try {
        const file = await fs.open(join(root, name))
        try {
          for (let at = 0; at < bytes.length; at += CHUNK) {
            const chunk = bytes.subarray(at, at + CHUNK)
            await file.write(chunk)
            written += chunk.length
            pct(Math.round((100 * written) / bytes.length))
          }
          await file.sync()
        } finally {
          await file.close().catch(() => {})
        }
        return true
      } catch {
        return written === bytes.length
      }
    }
  }
}
