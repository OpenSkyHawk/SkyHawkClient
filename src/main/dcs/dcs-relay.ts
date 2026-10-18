// The relay (#69): the DCS-BIOS stream, and the one on/off. Orchestrates a live source —
// transport -> protocol parser -> decoder -> stats — and the ticks that push it to the renderer.
// Source-agnostic across Bridge (DCS <-> device), Monitor (LAN, read-only) and Replay (recorded
// capture); recording can tap any live mode.
//
// The device link is not started or stopped here. It is up whenever the board is plugged in
// (gateway/gateway-connection.ts); a source mode only chooses where the stream comes from and
// whether it reaches the device.
import {
  AIRCRAFT_NONE,
  TELEMETRY_IDLE,
  type AircraftStatus,
  type RecordState,
  type RelayFacts,
  type RelayResult,
  type RelayState,
  type ReplayLoad,
  type TelemetryReadout
} from '@shared/dcs'
import type { Emit, RelayStatus } from '@shared/app'
import type { LogEventInput } from '@shared/events'
import type { DeviceStatus } from '@shared/gateway'
import { isLinkUp } from '../gateway'
import { DcsBiosProtocol } from './bios-protocol'
import type { DcsConnection } from './dcs-connection'
import { relayContext, relayEvents } from './relay-events'
import {
  canRecord,
  captureView,
  deviceToDcs,
  exportToDevice,
  relayConfigChanged,
  relayFacts,
  replayView,
  type RelayOptions
} from './relay-rules'
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
interface RelaySettings {
  getState(): RelayOptions
}

export interface DcsRelayDeps {
  /** The settings the relay is built from. */
  settings: RelaySettings
  /**
   * Save the settings as they stand: Start's first step (the renderer saved its forms before
   * asking for Start; config:edit with nothing changed, R3.3).
   */
  saveSettings(): void
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
  /** The recording and the capture, as their intents last answered (a reload keeps them, N1). */
  private recordingView: RelayFacts['recording'] = { on: false }
  private replayLoaded?: RelayFacts['replay']
  /**
   * The gauges and the aircraft as the telemetry tick last pushed them: what the screen shows,
   * stopped or not, so a renderer that (re)loads is handed them (N1).
   */
  private telemetry: TelemetryReadout[] = TELEMETRY_IDLE
  private aircraft: AircraftStatus = AIRCRAFT_NONE
  /** The `relay:facts` last pushed, to push only a change. */
  private factsKey?: string
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
   * Never gated on the board (#159): a mode that delivers to it starts with no board and waits,
   * as it does through a drop (relay-rules waitingForDevice), and delivers once the link is up.
   */
  start(): RelayResult {
    return this.run()
  }

  /** A settings change: a running relay is rebuilt if a setting it is built from changed. */
  reconfigure(prev: RelayOptions, next: RelayOptions): void {
    if (this.running && relayConfigChanged(prev, next)) {
      // A rebuild of a relay already running: only Stop may end it, so a rebuild during a drop
      // keeps it running, waiting for the board.
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
        setInterval(() => this.flushTelemetry(), TELEMETRY_MS),
        setInterval(() => this.emit('stats:tick', this.stats.snapshot()), STATS_MS)
      ]
      return { ok: true }
    } catch (err) {
      this.stop()
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * The Relay pill and the Start / Stop button (`relay:toggle`, R3.3): what the renderer's store
   * did on a click — Stop if it showed the relay running, else save the settings, then Start.
   * `relaying` is what the renderer showed; it takes back its own pending Start if refused.
   */
  toggle(relaying: boolean): RelayResult {
    if (relaying) return this.stop()
    this.deps.saveSettings()
    return this.start()
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

  /**
   * Whether it is relaying, the relay's state, and the gauges and aircraft last pushed, for the
   * renderer's rehydrate bundle.
   */
  status(): Pick<RelayStatus, 'running' | 'relay' | 'aircraft' | 'telemetry'> {
    return {
      running: this.running,
      relay: this.relay,
      aircraft: this.aircraft,
      telemetry: this.telemetry
    }
  }

  // ── what the relay's surfaces show (relay:facts, R3.3) ─────────────────────

  /** The facts as they stand: the rehydrate bundle's, and what `relay:facts` pushes. */
  facts(): RelayFacts {
    const deviceState = this.device.deviceStatus().state
    return relayFacts({
      config: this.config,
      stream: this.relay.stream,
      deviceState,
      linkUp: isLinkUp(deviceState),
      recording: this.recordingView,
      replay: this.replayLoaded
    })
  }

  /**
   * May the Record control act now (X12, relay-rules canRecord): start a recording only while
   * relaying; stop one already on whenever. The rule the surfaces' `canRecord` shows.
   */
  mayRecord(): boolean {
    return canRecord(this.running, this.recorder.isRecording())
  }

  /** The link or the settings changed (AppServices): push the facts if they changed with them. */
  inputsChanged(): void {
    this.pushFacts()
  }

  /** The capture toggle answered (`capture:toggle`): the Record controls follow its answer. */
  showCapture(state: RecordState): void {
    this.recordingView = captureView(state)
    this.pushFacts()
  }

  /** A capture was opened (`replay:open`): the Capture card follows its answer. */
  showReplay(load: ReplayLoad): void {
    this.replayLoaded = replayView(load, this.replayLoaded)
    this.pushFacts()
  }

  private pushFacts(): void {
    const facts = this.facts()
    const key = JSON.stringify(facts)
    if (key === this.factsKey) return
    this.factsKey = key
    this.emit('relay:facts', facts)
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  /** The telemetry tick (sim-telemetry-decoder.ts), what it pushed remembered for a reload. */
  private flushTelemetry(): void {
    const { telemetry, aircraft } = flushTelemetry(this.decoder, this.emit)
    this.telemetry = telemetry
    if (aircraft) this.aircraft = aircraft
  }

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
    this.pushFacts()
  }
}
