// Replay a captured DCS-BIOS session as a synthetic export source (drive the parser/UI with no
// DCS running). Reads the capture-file.ts format, which session-recorder.ts writes.
import { readFileSync } from 'node:fs'
import { captureDurationMs, parseCapture, type CaptureFile } from './capture-file'

export interface ReplayInfo {
  events: number
  durationMs: number
  aircraft?: string
}

export class ReplaySource {
  private readonly file: CaptureFile
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(file: CaptureFile) {
    this.file = file
  }

  static load(path: string): ReplaySource {
    return new ReplaySource(parseCapture(readFileSync(path, 'utf8')))
  }

  info(): ReplayInfo {
    return {
      events: this.file.events.length,
      durationMs: captureDurationMs(this.file),
      aircraft: this.file.aircraft
    }
  }

  /** Schedule the recorded export ("in") events at their original timing. */
  play(onExport: (chunk: Buffer) => void, onDone: () => void): void {
    for (const e of this.file.events) {
      if (e.dir !== 'in') continue
      this.timers.push(setTimeout(() => onExport(Buffer.from(e.hex, 'hex')), e.t))
    }
    this.timers.push(setTimeout(onDone, captureDurationMs(this.file) + 50))
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }
}
