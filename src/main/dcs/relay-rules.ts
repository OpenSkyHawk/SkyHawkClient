// Relay rules (pure, no Node/Electron deps): which way the stream goes in each source mode, which
// settings a running relay is built from, and what the relay's surfaces show (R3.3).
import type { AppConfig, DcsTransport, SourceMode } from '@shared/config'
import type {
  CaptureState,
  EndpointLabel,
  OverviewLink,
  RelayFacts,
  RelaySurfaces,
  RelayTip,
  RelayWaiting,
  ReplayLoad,
  StreamState
} from '@shared/dcs'
import type { DeviceState } from '@shared/gateway'

/** Settings a running relay is built from. Changing anything else must not restart it. */
export const RELAY_KEYS = [
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
// Moved from the renderer (device-view.ts, RelayPill.tsx, Connection.tsx, Overview.tsx,
// ConnectionSection.tsx): DcsRelay decides these and pushes them on `relay:facts`; the renderer
// keeps the wording. `relaying` is the on/off as the surface shows it: the renderer's pending
// Start or Stop reads at once, before main answers, so each fact comes for both.

interface RelayOpts {
  mode: SourceMode
  relaying: boolean
  stream?: StreamState
  deviceState: DeviceState
}

/** Running, but Bridge has no device to deliver to. */
const waitingForDevice = (o: RelayOpts): boolean =>
  o.relaying && o.mode === 'bridge' && o.deviceState !== 'connected'

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
  const needsBoard = opts.mode === 'bridge' || (opts.mode === 'replay' && opts.replayDriveSerial)
  return needsBoard && opts.deviceState !== 'connected'
}

/**
 * A running relay that is not delivering end to end — shown degraded rather than green. It keeps
 * running and resumes on its own; this only stops the pill claiming data is flowing when it is not.
 * Bridge also needs the device; Monitor and Replay never use it.
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
 * The Overview Link tile's sub-line. "Waiting" whenever a relay runs with the link down, whatever
 * the mode — Monitor included, which never uses the link (N2).
 */
export function overviewLink(relaying: boolean, linkUp: boolean): OverviewLink {
  return linkUp
    ? relaying
      ? 'gateway-relaying'
      : 'gateway-stopped'
    : relaying
      ? 'waiting'
      : 'stopped'
}

/**
 * The Relay pill's endpoint (X9, its own variant): the host and port as typed for TCP, the
 * multicast group for loopback, `unicast listen` for unicast.
 */
export function pillEndpoint(transport: DcsTransport): EndpointLabel {
  return transport === 'tcp-to-host'
    ? { hostPort: { suffix: '' } }
    : transport === 'loopback-multicast'
      ? { text: '239.255.50.10:5010' }
      : { text: 'unicast listen' }
}

/**
 * The Overview DCS Link tile's endpoint (X9, its own variant): the multicast group for Unicast
 * too, as it reads today.
 */
export function overviewEndpoint(transport: DcsTransport): EndpointLabel {
  return transport === 'tcp-to-host'
    ? { hostPort: { suffix: ' · remote' } }
    : { text: '239.255.50.10:5010 · local' }
}

/**
 * May a recording start (X12, each surface its own variant): the Connection tab's Record card
 * only while relaying; Settings › Connection's Record whenever.
 */
export function canRecord(relaying: boolean): RelaySurfaces['canRecord'] {
  return { connection: relaying, settings: true }
}

/** The Record control as this page last set it: from the capture toggle's answer. */
export function captureView(state: CaptureState): RelayFacts['recording'] {
  return { on: state.recording, events: state.events }
}

/** The capture this page loaded: from the replay open's answer, kept when nothing loaded. */
export function replayView(load: ReplayLoad, prev: RelayFacts['replay']): RelayFacts['replay'] {
  if (!load.loaded) return prev
  return { file: load.path!, events: load.events ?? 0, durationMs: load.durationMs ?? 0 }
}

/** What DcsRelay judges the surfaces against. */
export interface RelayInputs {
  config: Pick<AppConfig, 'sourceMode' | 'replayDriveSerial' | 'transport'>
  stream?: StreamState
  deviceState: DeviceState
  /** The link is up (the gateway's isLinkUp). */
  linkUp: boolean
  recording: RelayFacts['recording']
  replay?: RelayFacts['replay']
}

/** The surfaces for one state of the on/off. */
function surfaces(i: RelayInputs, relaying: boolean): RelaySurfaces {
  const o = { mode: i.config.sourceMode, relaying, stream: i.stream, deviceState: i.deviceState }
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
    overviewLink: overviewLink(relaying, i.linkUp),
    canRecord: canRecord(relaying)
  }
}

/** `relay:facts`: both sides of the on/off, the endpoints, the recording and the capture. */
export function relayFacts(i: RelayInputs): RelayFacts {
  return {
    running: surfaces(i, true),
    stopped: surfaces(i, false),
    ...(i.stream !== undefined ? { stream: i.stream } : {}),
    deviceState: i.deviceState,
    endpoint: {
      pill: pillEndpoint(i.config.transport),
      overview: overviewEndpoint(i.config.transport)
    },
    recording: i.recording,
    ...(i.replay ? { replay: i.replay } : {})
  }
}
