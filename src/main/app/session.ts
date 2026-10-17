// The main process's services, built and wired: the Gateway link (gateway/), the nodes (nodes/),
// HID and calibration (hid/), and the DCS side — the relay, its network end, the stream log, the
// stats and the recorder (dcs/), the settings (config/) and the event log (events/). Each lives
// with its owner; Session only builds and connects them, and answers the rehydrate bundle.
//
// The device link is not started or stopped by the relay. It is up whenever the board is plugged
// in (gateway/gateway-connection.ts); a source mode only chooses where the stream comes from and
// whether it reaches the device.
import type { DeviceStatus } from '@shared/gateway'
import type { PushChannel, PushChannels, RelayStatus } from '@shared/app'
import { app } from 'electron'
import { DcsConnection, DcsRelay, SessionRecorder, Stats, StreamLog } from '../dcs'
import { SettingsService } from '../config'
import { EventJournal } from '../events'
import { deviceEvent, DeviceLineTap, GatewayConnection, SerialTrafficMonitor } from '../gateway'
import { HidService } from '../hid'
import { HidCalibrationService } from '../hid/calibration'
import { NodeHub, NodeRoster } from '../nodes'
import { debugLog, setDebugEnabled } from './debug-log'
import { storeFiles, storePaths, type StorePaths } from './user-data'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

export class Session {
  /** The Gateway's USB serial port. Up independently of the relay. */
  readonly connection: GatewayConnection
  /** The port's text lines, read: node lines to NodeHub, panel commands to the log. */
  readonly lines: DeviceLineTap
  /** The Serial tab's raw view of the port. */
  readonly serialMonitor: SerialTrafficMonitor
  /** The node roster, node data and mapping, and the Gateway's health (UD-C). */
  readonly nodes: NodeHub
  /** Axis calibration (#46), riding on the Gateway port. */
  readonly calibration: HidCalibrationService
  /** The HID joystick, up for as long as the app is. */
  readonly hid: HidService
  /** The settings (config.json): the live copy, its store, and config:set. */
  readonly settings: SettingsService
  /** The event log (#64): where every owner reports its rows; events:get / clear / export. */
  readonly journal: EventJournal
  /** The relay: Start/Stop, the source mode, the stream and its ticks. */
  readonly relay: DcsRelay
  /** Recording a live session to a capture file. */
  readonly recorder: SessionRecorder
  /** The relay's network end: the link to DCS-BIOS. */
  private readonly dcs: DcsConnection
  /** The Log tab's stream rows and their flush. */
  private readonly streamLog: StreamLog
  private readonly stats = new Stats()

  /**
   * `paths`: the <userData> files, from app/index.ts. The default resolves the same paths the
   * same way, for callers that build a Session on its own.
   */
  constructor(emit: Emit, paths: StorePaths = storePaths(() => app.getPath('userData'))) {
    const { mappingFile, cacheFile } = storeFiles(paths)
    this.settings = new SettingsService({ paths, debugMode: (on) => setDebugEnabled(on) })
    this.journal = new EventJournal(emit, debugLog)
    this.calibration = new HidCalibrationService(emit, {
      write: (data) => this.connection.write(data),
      serialNumber: () => this.connection.usbSerialNumber(),
      cacheFile,
      log: debugLog
    })
    this.hid = new HidService(emit, debugLog)
    this.connection = new GatewayConnection(emit, {
      log: debugLog,
      frames: this.calibration,
      health: () => this.nodes.gatewayHealth()
    })
    this.nodes = new NodeHub(emit, new NodeRoster(), (events) => this.journal.report(events), {
      mappingFile,
      log: debugLog,
      link: this.connection
    })
    this.serialMonitor = new SerialTrafficMonitor(emit)
    this.lines = new DeviceLineTap(this.nodes)
    this.recorder = new SessionRecorder()
    this.streamLog = new StreamLog(emit, this.stats, this.journal)
    this.dcs = new DcsConnection()
    this.relay = new DcsRelay(emit, {
      settings: this.settings.store,
      device: this.connection,
      dcs: this.dcs,
      stats: this.stats,
      log: this.streamLog,
      recorder: this.recorder,
      events: this.journal
    })
    // The wiring order is load-bearing (R2.2b): it is the order DeviceLink ran these in before the
    // split. At each of the connection's moments its riders run in the order added:
    //   start's timers   link tick (200, its own) → serial flush (50) → cal:raw (50) →
    //                    HID rate (1000) → roster poll (5000); then the HID reader
    //   port opens       `opening`: node resets, then the line assembler → connected status →
    //                    `connected`: roster request → `opened`: calibration read, HID reopen
    //   port closes      `closing`: nodes' last seen → `closed`: calibration → reconnect/disconnect
    //   teardown         `release`: calibration → port stop → `released`: the Gateway's health
    //   200 ms tick      `flush`: HID → (link up) `tick`: node pushes, Gateway health
    //   shutdown         `closing`: nodes → timers cleared → teardown → `stop`: HID
    // The DCS side keeps Session's order too (R2.3a). None of its constructors has a side effect.
    //   open             the stream log's flush (33) first, then the connection's start
    //   relay Start      Bridge / driven Replay refused unless the link is up → a running relay
    //                    stopped → decoder, parser, stats reset → DCS error forgotten → Replay:
    //                    `connected`, playback; else the transport built and subscribed →
    //                    `connecting` → transport start; then the telemetry (200) and stats
    //                    (1000) ticks
    //   relay Stop       ticks cleared → replay stopped → transport stopped (forgotten first, so
    //                    its close is stale) → the stream log flushed → `stopped`
    //   export chunk     stats in → parser (named rows: stats frames, then the log) → recorder →
    //                    device write (Bridge / driven Replay, not while calibration gates it)
    //   shutdown         relay Stop → the connection's shutdown → the stream log's flush cleared
    // Settings and the event log (R2.3b). Neither constructor has a side effect. The settings
    // store is one instance: the relay reads it (`settings.store`); the connection is handed its
    // auto-connect slice at open and, on a change, by the store's subscriber.
    //   settings change  the store's one subscriber, below: auto-connect → the relay rebuilt if a
    //                    setting it is built from changed. config:set and a config import then
    //                    switch the debug log and write config.json; the launch seed only
    //                    switches the debug log
    //   stream-log flush the event log's new rows (`events:batch`), then the stream's (`log:batch`)
    this.connection.ride(this.serialMonitor)
    this.connection.ride(this.calibration)
    this.connection.ride(this.hid)
    this.connection.ride(this.nodes.rider)
    this.connection.ride(this.lines)
    // Port traffic: the serial monitor taps it raw, above the frame filter.
    this.connection.onTraffic((dir, chunk) => this.serialMonitor.onSerialTraffic(dir, chunk))
    // Bytes below the frame filter: the relay to DCS first, then the line tap — the order
    // DeviceLink handed them on in.
    this.connection.onBytes((bytes) => this.relay.fromDevice(bytes))
    this.connection.onBytes((bytes) => this.lines.push(bytes))
    // Panel commands to the stream log, relaying or not.
    this.lines.onLine((l) => this.streamLog.onLine(l))
    // Link faults and the v2-Gateway warning: one path, as when DeviceLink raised both.
    const onError = (tag: string, message: string): void => {
      this.stats.error()
      this.journal.error(tag, message)
    }
    this.connection.onError(onError)
    this.nodes.onError(onError)
    this.connection.onStatus((s) => {
      if (s.state === 'reconnecting') this.stats.reconnect()
      // The port's own retry loop stays in `error`; any other state (an explicit Connect or Retry
      // goes through `scanning`) ends that loop, so the next failure is news again.
      if (s.state !== 'error') this.journal.forget('SERIAL')
      this.journal.linkState(s.state, (last) => deviceEvent(last, s, Date.now()))
    })
    // A settings change, in one listener so its order is explicit: auto-connect, then the relay.
    this.settings.store.subscribe((config, prev) => {
      if (prev.autoConnect !== config.autoConnect) {
        this.connection.setAutoConnect(config.autoConnect)
      }
      this.relay.reconfigure(prev, config)
    })
  }

  /** App launch: bring up the device link and the log, independent of any relay. */
  open(): void {
    if (!this.streamLog.open()) return
    this.connection.start(this.settings.get().autoConnect)
  }

  /** App quit. */
  shutdown(): void {
    this.relay.stop()
    this.connection.shutdown()
    this.streamLog.close()
  }

  /** Snapshot so a (re)loaded renderer can rehydrate the relay and link state. */
  status(): RelayStatus {
    const device: DeviceStatus = this.connection.deviceStatus()
    const { running, relay } = this.relay.status()
    return { running, relay, device, cal: this.calibration.calSnapshot() }
  }
}
