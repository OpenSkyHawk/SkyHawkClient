// Record a live DCS-BIOS session to disk: the export coming in and the device traffic going out,
// in the capture-file.ts format replay-source.ts plays back, so captures are portable.
import { writeFileSync } from 'node:fs'
import { serializeCapture } from './capture-file'
import type { CaptureEvent, CaptureMeta } from '@shared/dcs'

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

/** The one capture being recorded, if any: the relay taps every live mode into it. */
export class SessionRecorder {
  private recorder?: Recorder
  private recordPath?: string

  startRecording(path: string): void {
    this.recorder = new Recorder()
    this.recordPath = path
  }

  stopRecording(): { path?: string; events: number } {
    const events = this.recorder?.count ?? 0
    if (this.recorder && this.recordPath) this.recorder.save(this.recordPath)
    const path = this.recordPath
    this.recorder = undefined
    this.recordPath = undefined
    return { path, events }
  }

  isRecording(): boolean {
    return !!this.recorder
  }

  /** One chunk of the stream, while recording: export `in`, device traffic `out`. */
  record(dir: 'in' | 'out', chunk: Buffer): void {
    this.recorder?.record(dir, chunk)
  }
}
