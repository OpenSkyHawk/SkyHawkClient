// Capture a live DCS-BIOS session to disk, and replay one as a synthetic export
// source (drive the parser/UI with no DCS running). Reuses the @shared/capture
// format so captures are portable.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  captureDurationMs,
  parseCapture,
  serializeCapture,
  type CaptureEvent,
  type CaptureFile,
  type CaptureMeta
} from '@shared/capture'

export class Recorder {
  private events: CaptureEvent[] = []
  private startedAt = Date.now()

  reset(): void {
    this.events = []
    this.startedAt = Date.now()
  }

  record(dir: 'in' | 'out', chunk: Buffer): void {
    this.events.push({ t: Date.now() - this.startedAt, dir, hex: chunk.toString('hex') })
  }

  get count(): number {
    return this.events.length
  }

  save(path: string, meta: CaptureMeta = {}): void {
    writeFileSync(path, serializeCapture(this.events, meta))
  }
}

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
