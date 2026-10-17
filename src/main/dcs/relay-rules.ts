// Relay rules (pure, no Node/Electron deps): which way the stream goes in each source mode, which
// settings a running relay is built from, and what the relay's surfaces show (R3.3).
import type { AppConfig, SourceMode } from '@shared/config'
import {
  EXPORT_MULTICAST_ADDR,
  EXPORT_PORT,
  type RecordState,
  type OverviewLink,
  type RelayFacts,
  type RelaySurfaces,
  type RelayTip,
  type RelayWaiting,
  type ReplayLoad,
  type StreamState
} from '@shared/dcs'
import type { DeviceState } from '@shared/gateway'

/** Settings a running relay is built from. Changing anything else must not restart it. */
const RELAY_KEYS = [
  'sourceMode',
  'transport',
  'host',
  'commandPort',
  'listenPort',
  'replayDriveSerial'
] as const satisfies readonly (keyof AppConfig)[]

/** The settings the relay reads: exactly the ones it is built from (RELAY_KEYS). */
export type RelayOptions = Pick<AppConfig, (typeof RELAY_KEYS)[number]>

type ForwardConfig = Pick<RelayOptions, 'sourceMode' | 'replayDriveSerial'>

/**
 * Whether the export stream is written to the SimGateway — and so whether Start needs the board.
 *
 * Bridge always; Replay only with "Drive SimGateway"; Monitor never. Monitor has to say so
 * explicitly now that the port is open in every mode — before #69 it was read-only only because
 * it had no port to write to.
 */
export function exportToDevice(cfg: ForwardConfig): boolean {
  return cfg.sourceMode === 'bridge' || (cfg.sourceMode === 'replay' && cfg.replayDriveSerial)
}

/** Whether device traffic goes on to DCS: only a running Bridge relay has a DCS to send it to. */
export function deviceToDcs(cfg: ForwardConfig, running: boolean): boolean {
  return running && cfg.sourceMode === 'bridge'
}

export function relayConfigChanged<T extends RelayOptions>(prev: T, next: T): boolean {
  return RELAY_KEYS.some((k) => prev[k] !== next[k])
}

// ── what the relay's surfaces show (R3.3) ────────────────────────────────────
// Moved from the renderer (the title bar, Connection, Overview and Settings › Connection):
// DcsRelay decides these and pushes them on `relay:facts`; the renderer
// keeps the wording. `relaying` is the on/off as the surface shows it: the renderer's pending
// Start or Stop reads at once, before main answers, so each fact comes for both.

interface RelayOpts {
  mode: SourceMode
  /** Replay's "Drive Gateway": a Replay that delivers to the board (N3). */
  replayDriveSerial: boolean
  relaying: boolean
  stream?: StreamState
  deviceState: DeviceState
}

/**
 * Running, but a mode that delivers to the board has no board to deliver to: Bridge, and a Replay
 * driving the Gateway (N3). Monitor and an undriven Replay never wait for it (N2).
 */
const waitingForDevice = (o: RelayOpts): boolean =>
  o.relaying &&
  exportToDevice({ sourceMode: o.mode, replayDriveSerial: o.replayDriveSerial }) &&
  o.deviceState !== 'connected'

/** Running, but the DCS-BIOS stream is not up. Replay has no DCS to wait for. */
const waitingForDcs = (o: RelayOpts): boolean =>
  o.relaying && o.mode !== 'replay' && o.stream !== 'connected'

/**
 * Which tooltip the relay pill shows: where the DCS-BIOS stream stands. A relay keeps running
 * through a drop, so while it is waiting the tooltip says what for, rather than looking broken.
 */
export function relayTip(opts: RelayOpts): RelayTip {
  if (opts.mode === 'replay') {
    if (!opts.relaying) return 'replay-stopped'
    if (waitingForDevice(opts)) return 'waiting-device'
    if (opts.stream === 'ended') return 'replay-ended'
    return 'replay-playing'
  }
  if (!opts.relaying) return 'stopped'
  if (waitingForDevice(opts)) return 'waiting-device'
  if (waitingForDcs(opts)) return 'waiting-dcs'
  return 'delivering'
}

/** What a running relay is waiting for: the line under the Connection tab's Start / Stop button. */
export function relayNote(opts: RelayOpts): RelayWaiting {
  if (waitingForDevice(opts)) return 'device'
  if (waitingForDcs(opts)) return 'dcs'
  if (opts.relaying && opts.mode === 'replay' && opts.stream === 'ended') return 'replay-ended'
  return 'none'
}

/**
 * Start is refused while a mode that delivers to the board has no board to deliver to: Bridge, and
 * Replay driving the SimGateway. Monitor and an undriven Replay never touch it. The same rule as
 * DcsRelay.start(), which is the one that actually enforces it.
 */
export function startBlocked(opts: {
  mode: SourceMode
  replayDriveSerial: boolean
  deviceState: DeviceState
}): boolean {
  const needsBoard = exportToDevice({
    sourceMode: opts.mode,
    replayDriveSerial: opts.replayDriveSerial
  })
  return needsBoard && opts.deviceState !== 'connected'
}

/**
 * A running relay that is not delivering end to end — shown degraded rather than green. It keeps
 * running and resumes on its own; this only stops the pill claiming data is flowing when it is not.
 * Bridge and a driven Replay also need the device; Monitor and an undriven Replay never use it.
 */
export function relayWaiting(opts: RelayOpts): boolean {
  if (!opts.relaying) return false
  return (
    waitingForDevice(opts) ||
    waitingForDcs(opts) ||
    (opts.mode === 'replay' && opts.stream === 'ended')
  )
}

/**
 * The Overview Link tile's sub-line. "Waiting" only while a running relay waits for the board — the
 * same rule as the pill and the note under Start, so Monitor and an undriven Replay, which never
 * use the link, never say it (N2). Otherwise the relay is simply running.
 */
export function overviewLink(opts: RelayOpts, linkUp: boolean): OverviewLink {
  if (linkUp) return opts.relaying ? 'gateway-relaying' : 'gateway-stopped'
  if (waitingForDevice(opts)) return 'waiting'
  return opts.relaying ? 'running' : 'stopped'
}

/**
 * Where the relay's stream comes from (X9): the one endpoint label every surface shows — the Relay
 * pill, the Overview's DCS Link tile and the event log. The host and command port the TCP link
 * connects to; the multicast group and port loopback joins; the port Unicast binds, on every
 * address (transports.ts binds it with none).
 */
export function relayEndpoint(
  cfg: Pick<AppConfig, 'transport' | 'host' | 'commandPort' | 'listenPort'>
): string {
  switch (cfg.transport) {
    case 'tcp-to-host':
      return `${cfg.host}:${cfg.commandPort}`
    case 'loopback-multicast':
      return `${EXPORT_MULTICAST_ADDR}:${EXPORT_PORT}`
    case 'unicast-listen':
      return `0.0.0.0:${cfg.listenPort}`
  }
}

/**
 * May a recording start (X12): only while relaying, on every surface that offers it — the
 * Connection tab's Record card and Settings › Connection's Record row. A recording already on can
 * always be stopped, so a relay stopped mid-recording never strands it.
 */
export function canRecord(relaying: boolean, recording: boolean): boolean {
  return relaying || recording
}

/**
 * Is a Record control shown at all (R3.4a, each surface its own variant): the
 * Connection tab's Record card is hidden in Replay (the renderer's rule before); Settings ›
 * Connection's Record row always shows.
 */
export function recordShown(mode: SourceMode): RelayFacts['recordShown'] {
  return { connection: mode !== 'replay', settings: true }
}

/**
 * Is the Connection tab's Capture card shown (R3.4a: the renderer's rule before): Replay only. The
 * mirror of the Record card's rule, beside it, so both come from the same mode in the same push.
 */
export function captureShown(mode: SourceMode): boolean {
  return mode === 'replay'
}

/** The Record control as this page last set it: from the capture toggle's answer. */
export function captureView(state: RecordState): RelayFacts['recording'] {
  return { on: state.recording, events: state.events }
}

/** The capture this page loaded: from the replay open's answer, kept when nothing loaded. */
export function replayView(load: ReplayLoad, prev: RelayFacts['replay']): RelayFacts['replay'] {
  if (!load.loaded) return prev
  return { file: load.path!, events: load.events ?? 0, durationMs: load.durationMs ?? 0 }
}

/** What DcsRelay judges the surfaces against. */
export interface RelayInputs {
  config: Pick<
    AppConfig,
    'sourceMode' | 'replayDriveSerial' | 'transport' | 'host' | 'commandPort' | 'listenPort'
  >
  stream?: StreamState
  deviceState: DeviceState
  /** The link is up (the gateway's isLinkUp). */
  linkUp: boolean
  recording: RelayFacts['recording']
  replay?: RelayFacts['replay']
}

/** The surfaces for one state of the on/off. */
function surfaces(i: RelayInputs, relaying: boolean): RelaySurfaces {
  const o = {
    mode: i.config.sourceMode,
    replayDriveSerial: i.config.replayDriveSerial,
    relaying,
    stream: i.stream,
    deviceState: i.deviceState
  }
  const blocked =
    !relaying &&
    startBlocked({
      mode: i.config.sourceMode,
      replayDriveSerial: i.config.replayDriveSerial,
      deviceState: i.deviceState
    })
  return {
    waiting: relayNote(o),
    tip: relayTip(o),
    ...(blocked ? { startBlocked: i.config.sourceMode === 'replay' ? 'replay' : 'bridge' } : {}),
    overviewLink: overviewLink(o, i.linkUp),
    canRecord: canRecord(relaying, i.recording.on)
  }
}

/** `relay:facts`: both sides of the on/off, the endpoint, the recording and the capture. */
export function relayFacts(i: RelayInputs): RelayFacts {
  return {
    mode: i.config.sourceMode,
    transport: i.config.transport,
    running: surfaces(i, true),
    stopped: surfaces(i, false),
    ...(i.stream !== undefined ? { stream: i.stream } : {}),
    deviceState: i.deviceState,
    endpoint: relayEndpoint(i.config),
    recording: i.recording,
    recordShown: recordShown(i.config.sourceMode),
    captureShown: captureShown(i.config.sourceMode),
    ...(i.replay ? { replay: i.replay } : {})
  }
}
