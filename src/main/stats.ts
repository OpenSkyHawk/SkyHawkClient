// Rolling counters for the Stream Health / Command Activity panels.
// snapshot() reports per-second rates as deltas since the previous snapshot,
// so it is expected to be called on a steady ~1 Hz tick.
import type { StatsSnapshot } from '@shared/ipc'

export class Stats {
  private bytesIn = 0
  private bytesOut = 0
  private frames = 0
  private commands = 0
  private commandsTotal = 0
  private errors = 0
  private reconnects = 0
  private lastCommand?: string
  private startedAt = Date.now()

  private prev = { bytesIn: 0, bytesOut: 0, frames: 0, commands: 0, at: Date.now() }

  reset(): void {
    this.bytesIn = 0
    this.bytesOut = 0
    this.frames = 0
    this.commands = 0
    this.commandsTotal = 0
    this.errors = 0
    this.reconnects = 0
    this.lastCommand = undefined
    this.startedAt = Date.now()
    this.prev = { bytesIn: 0, bytesOut: 0, frames: 0, commands: 0, at: Date.now() }
  }

  addIn(bytes: number): void {
    this.bytesIn += bytes
  }
  addOut(bytes: number): void {
    this.bytesOut += bytes
  }
  addFrames(n: number): void {
    this.frames += n
  }
  command(cmd: string): void {
    this.commands += 1
    this.commandsTotal += 1
    this.lastCommand = cmd
  }
  error(): void {
    this.errors += 1
  }
  reconnect(): void {
    this.reconnects += 1
  }

  snapshot(): StatsSnapshot {
    const now = Date.now()
    const dt = Math.max(0.001, (now - this.prev.at) / 1000)
    const snap: StatsSnapshot = {
      bytesInPerSec: Math.round((this.bytesIn - this.prev.bytesIn) / dt),
      bytesOutPerSec: Math.round((this.bytesOut - this.prev.bytesOut) / dt),
      framesPerSec: Math.round((this.frames - this.prev.frames) / dt),
      commandsPerSec: Math.round((this.commands - this.prev.commands) / dt),
      commandsTotal: this.commandsTotal,
      lastCommand: this.lastCommand,
      errors: this.errors,
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      reconnects: this.reconnects
    }
    this.prev = {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      frames: this.frames,
      commands: this.commands,
      at: now
    }
    return snap
  }
}
