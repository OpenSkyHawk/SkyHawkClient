// The main process's services, built and wired: the Gateway link (gateway/), the nodes (nodes/),
// HID and calibration (hid/), and the DCS side — the relay, its network end, the stream log, the
// stats and the recorder (dcs/), the settings (config/) and the event log (events/). Each lives
// with its owner; AppServices only builds and connects them, and answers the rehydrate bundle.
// It holds no rules and no state (UD-F): it is the seam the contract tests build with the edges
// faked (test-harness/services.ts).
//
// The device link is not started or stopped by the relay. It is up whenever the board is plugged
// in (gateway/gateway-connection.ts); a source mode only chooses where the stream comes from and
// whether it reaches the device.
import type { Emit, RelayStatus } from '@shared/app'
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

export class AppServices {
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
   * `paths`: the <userData> files, from app/bootstrap.ts. The default resolves the same paths
   * the same way, for callers that build an AppServices on its own.
   */
  constructor(emit: Emit, paths: StorePaths = storePaths(() => app.getPath('userData'))) {
    const { mappingFile, cacheFile } = storeFiles(paths)
    // The event log first (no constructor here has a side effect): the three <userData> files
    // report their problems to it (#136).
    this.journal = new EventJournal(emit, debugLog)
    this.settings = new SettingsService({
      paths,
      events: this.journal,
      debugMode: (on) => setDebugEnabled(on),
      emit
    })
    this.calibration = new HidCalibrationService(emit, {
      write: (data) => this.connection.write(data),
      serialNumber: () => this.connection.usbSerialNumber(),
      cacheFile,
      cacheEvents: this.journal,
      log: debugLog
    })
    this.hid = new HidService(emit, debugLog)
    this.connection = new GatewayConnection(emit, {
      log: debugLog,
      frames: this.calibration,
      health: () => this.nodes.gatewayHealth(),
      serialMonitor: () => this.serialMonitor.shown
    })
    this.nodes = new NodeHub(emit, new NodeRoster(), (events) => this.journal.report(events), {
      mappingFile,
      mappingEvents: this.journal,
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
      saveSettings: () => void this.settings.edit({}),
      device: this.connection,
      dcs: this.dcs,
      stats: this.stats,
      log: this.streamLog,
      recorder: this.recorder,
      events: this.journal
    })
    // The wiring order is load-bearing (R2.2b): it is the order these ran in before the split. At
    // each of the connection's moments its riders run in the order added:
    //   start's timers   link tick (200, its own) → serial flush (50) → calibration RAW (50) →
    //                    HID rate (1000) → roster poll (5000); then the HID reader
    //   port opens       `opening`: node resets, then the line assembler → connected status →
    //                    `connected`: roster request → `opened`: calibration read, HID reopen
    //   port closes      `closing`: nodes' last seen → `closed`: calibration → reconnect/disconnect
    //   teardown         `release`: calibration → port stop → `released`: the Gateway's health
    //   200 ms tick      `flush`: HID → (link up) `tick`: node pushes, Gateway health, re-ask
    //   Retry            `closing`: nodes' last seen → teardown → a fresh port (M7)
    //   shutdown         `closing`: nodes → timers cleared → teardown → `stop`: HID
    // The DCS side keeps its order from before the split too (R2.3a). None of its constructors has
    // a side effect.
    //   open             the stream log's flush (33) first, then the connection's start
    //   relay Start      never gated on the link (#159) → a running relay
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
    // The page's serial-monitor flag rides on `device:status` (R3.3): setting it pushes the status.
    this.serialMonitor.onShownChange(() => this.connection.pushStatus())
    this.connection.ride(this.serialMonitor)
    this.connection.ride(this.calibration)
    this.connection.ride(this.hid)
    this.connection.ride(this.nodes.rider)
    this.connection.ride(this.lines)
    // Port traffic: the serial monitor taps it raw, above the frame filter.
    this.connection.onTraffic((dir, chunk) => this.serialMonitor.onSerialTraffic(dir, chunk))
    // Bytes below the frame filter: the relay to DCS first, then the line tap — the order they
    // were handed on in before the split.
    this.connection.onBytes((bytes) => this.relay.fromDevice(bytes))
    this.connection.onBytes((bytes) => this.lines.push(bytes))
    // Panel commands to the stream log, relaying or not.
    this.lines.onLine((l) => this.streamLog.onLine(l))
    // Link faults and the v2-Gateway warning: one path, as before the split.
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
    // The calibration workflow follows the link (pauses on a drop, drops the device's report),
    // after the link's own reactions and after `device:status` has gone out (R3.1).
    this.connection.onStatus((s) => this.calibration.linkStatus(s.state))
    // The HID tab's live axes follow what calibration reports the device declares (R3.3), after
    // `cal:workflow` has gone out, as the tab re-rendered on it.
    this.calibration.onWorkflow((st) => this.hid.calibrationChanged(st.tab.snapshot))
    // The Cockpit snapshot follows the link too (strays and Attention only while it is up), after
    // `device:status` has gone out, as the Cockpit re-rendered on it (R3.2).
    this.connection.onStatus(() => this.nodes.linkStatus())
    // So do the relay's facts (waiting for the Gateway, the Link tile), R3.3.
    this.connection.onStatus(() => this.relay.inputsChanged())
    // A settings change, in one listener so its order is explicit: auto-connect, then the relay.
    this.settings.store.subscribe((config, prev) => {
      if (prev.autoConnect !== config.autoConnect) {
        this.connection.setAutoConnect(config.autoConnect)
      }
      this.relay.reconfigure(prev, config)
      // The relay's facts follow the settings (the mode, Drive Gateway, the transport), R3.3.
      this.relay.inputsChanged()
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
    this.nodes.dispose()
  }

  /**
   * A renderer (re)loaded (`relay:status`, its first pull): it has the HID report and its live
   * axes now, as it has its catalogue from a pull. What main holds for the screen — the link's
   * "last known" time, the serial monitor's flag, the recording, the capture, the aircraft and
   * the gauges — is kept, and the bundle hands it over (N1).
   */
  rendererLoaded(): void {
    this.hid.rendererLoaded()
  }

  /** Snapshot so a (re)loaded renderer can rehydrate what main holds for the screen (N1). */
  status(): RelayStatus {
    const device = this.connection.statusPush()
    const { running, relay, aircraft, telemetry } = this.relay.status()
    return {
      running,
      relay,
      relayFacts: this.relay.facts(),
      aircraft,
      telemetry,
      device,
      cal: this.calibration.workflow.state()
    }
  }
}
