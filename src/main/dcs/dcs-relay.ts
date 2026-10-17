// The relay (#69): the DCS-BIOS stream, and the one on/off. Orchestrates a live source —
// transport -> protocol parser -> decoder -> stats — and the ticks that push it to the renderer.
// Source-agnostic across Bridge (DCS <-> device), Monitor (LAN, read-only) and Replay (recorded
// capture); recording can tap any live mode.
//
// The device link is not started or stopped here. It is up whenever the board is plugged in
// (gateway/gateway-connection.ts); a source mode only chooses where the stream comes from and
// whether it reaches the device.
import type { RelayResult, RelayState } from '@shared/dcs'
import type { Emit, RelayStatus } from '@shared/app'
import type { LogEventInput } from '@shared/events'
import type { DeviceStatus } from '@shared/gateway'
import { isLinkUp } from '../gateway'
import { DcsBiosProtocol } from './bios-protocol'
import type { DcsConnection } from './dcs-connection'
import { relayContext, relayEvents } from './relay-events'
import { deviceToDcs, exportToDevice, relayConfigChanged, type RelayOptions } from './relay-rules'
import { ReplaySource, type ReplayInfo } from './replay-source'
import type { SessionRecorder } from './session-recorder'
import { Decoder, flushTelemetry } from './sim-telemetry-decoder'
import { STATS_MS, type Stats } from './stream-stats'
import type { StreamLog } from './stream-log'

const TELEMETRY_MS = 200

/** The Gateway link, as the relay uses it (GatewayConnection). */
export interface RelayDevice {
  deviceStatus(): DeviceStatus
  write(data: Buffer): void
  /** A calibration exchange is in flight: the export forward to the board pauses. */
  readonly exportGated: boolean
}

/** The event log, as the relay reports to it. */
export interface RelayEventSink {
  add(events: LogEventInput[]): void
  /** A client error row, deduped per tag. */
  error(tag: string, message: string): void
  /** Forget the tag's last error, so the next one is news. */
  forget(tag: string): void
}

/** The settings, as the relay reads them: the SettingsStore, read when it needs them. */
export interface RelaySettings {
  getState(): RelayOptions
}

export interface DcsRelayDeps {
  /** The settings the relay is built from. */
  settings: RelaySettings
  device: RelayDevice
  dcs: DcsConnection
  stats: Stats
  log: StreamLog
  recorder: SessionRecorder
  events: RelayEventSink
}

export class DcsRelay {
  private replay?: ReplaySource
  private readonly parser: DcsBiosProtocol
  private decoder = new Decoder()
  private running = false
  private relay: RelayState = { running: false }
  private timers: ReturnType<typeof setInterval>[] = []
  private readonly device: RelayDevice
  private readonly dcs: DcsConnection
  private readonly stats: Stats
  private readonly log: StreamLog
  private readonly recorder: SessionRecorder
  private readonly events: RelayEventSink

  constructor(
    private readonly emit: Emit,
    private readonly deps: DcsRelayDeps
  ) {
    this.parser = new DcsBiosProtocol((addr, val) => this.onWrite(addr, val))
    this.device = deps.device
    this.dcs = deps.dcs
    this.stats = deps.stats
    this.log = deps.log
    this.recorder = deps.recorder
    this.events = deps.events
  }

  private get config(): RelayOptions {
    return this.deps.settings.getState()
  }

  /**
   * Start relaying. Attaches the stream to the device link; never opens or closes the port.
   *
   * Refused while a mode that delivers to the board has no board to deliver to: nothing can be
   * relayed before the link is up. Once running, a drop does not end the relay — it waits, and
   * resumes when the link returns.
   */
  start(): RelayResult {
    if (exportToDevice(this.config) && !isLinkUp(this.device.deviceStatus().state)) {
      return { ok: false, error: 'Gateway is not connected' }
    }
    return this.run()
  }

  /** A settings change: a running relay is rebuilt if a setting it is built from changed. */
  reconfigure(prev: RelayOptions, next: RelayOptions): void {
    if (this.running && relayConfigChanged(prev, next)) {
      // A rebuild of a relay already running, not a new Start: it is not gated on the device,
      // or editing a setting during a drop would end a relay that only Stop may end.
      this.stop()
      this.run()
    }
  }

  private run(): RelayResult {
    if (this.running) this.stop()
    this.decoder = new Decoder()
    this.parser.reset()
    this.stats.reset()
    this.events.forget('DCS') // a new relay reports its stream afresh
    const mode = this.config.sourceMode

    try {
      if (mode === 'replay') {
        const replay = this.replay
        if (!replay) return { ok: false, error: 'No capture loaded' }
        this.running = true
        this.setRelay({ running: true, stream: 'connected' })
        replay.play(
          (chunk) => this.onExport(chunk), // optionally drives the real cockpit from the capture
          () => this.setRelay({ running: true, stream: 'ended' })
        )
      } else {
        this.dcs.open(this.config, {
          export: (chunk) => this.onExport(chunk),
          error: (err) => {
            this.stats.error()
            this.events.error('DCS', err.message)
            this.setRelay({ running: true, stream: 'error', detail: err.message })
          },
          connected: (connected) => {
            if (connected) {
              this.setRelay({ running: true, stream: 'connected' })
            } else {
              this.stats.reconnect()
              this.setRelay({ running: true, stream: 'reconnecting' })
            }
          }
        })
        this.running = true
        this.setRelay({ running: true, stream: 'connecting' })
        this.dcs.start()
      }

      this.timers = [
        setInterval(() => flushTelemetry(this.decoder, this.emit), TELEMETRY_MS),
        setInterval(() => this.emit('stats:tick', this.stats.snapshot()), STATS_MS)
      ]
      return { ok: true }
    } catch (err) {
      this.stop()
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Stop relaying. The device link — HID, calibration, nodes — stays up. */
  stop(): RelayResult {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.replay?.stop()
    this.dcs.stop()
    this.log.flushLog()
    this.setRelay({ running: false })
    return { ok: true }
  }

  /** Load a capture for Replay, stopping the one loaded before. */
  loadReplay(path: string): ReplayInfo {
    this.replay?.stop()
    this.replay = ReplaySource.load(path)
    return this.replay.info()
  }

  /** Whether it is relaying, and the relay's state, for the renderer's rehydrate bundle. */
  status(): Pick<RelayStatus, 'running' | 'relay'> {
    return { running: this.running, relay: this.relay }
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  /** One chunk of the DCS-BIOS export, from DCS or a capture. */
  private onExport(chunk: Buffer): void {
    this.stats.addIn(chunk.length)
    this.parser.processBuffer(chunk)
    this.recorder.record('in', chunk)
    // Forward byte-for-byte to the SimGateway — unless a calibration exchange is in flight.
    // Parsing for our own UI continues; only the forward pauses.
    if (exportToDevice(this.config) && !this.device.exportGated) this.device.write(chunk)
  }

  /** Device traffic, calibration frames already removed by the link: relay to DCS:7778. */
  fromDevice(bytes: Buffer): void {
    if (!deviceToDcs(this.config, this.running)) return
    this.dcs.send(bytes)
    this.stats.addOut(bytes.length)
    this.recorder.record('out', bytes)
  }

  private onWrite(address: number, value: number): void {
    const rows = this.decoder.handle(address, value, Date.now())
    if (rows.length) {
      this.stats.addFrames(rows.length)
      this.log.rows(rows)
    }
  }

  private setRelay(relay: RelayState): void {
    this.events.add(relayEvents(this.relay, relay, relayContext(this.config), Date.now()))
    if (relay.stream === 'connected') this.events.forget('DCS') // a later drop's error is news

    this.relay = relay
    this.emit('relay:state', relay)
  }
}
