import type { DeviceState } from '@shared/gateway/ipc'
import type { StreamState } from '@shared/dcs/ipc'
import type { SourceMode } from './store'

/**
 * How each device-link state reads in the UI (#69): the title-bar indicator, the device card and
 * the nodes card. One table so the three never disagree about what a state is called.
 */
export interface DeviceView {
  /** Modifier on `.devind` — colour and dot style. */
  cls: string
  /** Title-bar label. */
  label: string
  /** Device-card chip. */
  chip: string
  /** Tooltip on both. */
  tip: string
  /** Detail line in the title-bar device popover; '' = none. */
  popMeta: string
  /** Serial port row of the device card. */
  portRow: string
  /** Hint in the nodes card while the link is down. */
  nodesHint: string
  /** The device card's Connect / Disconnect / Retry button. */
  button: {
    label: 'Connect' | 'Disconnect' | 'Retry'
    action: 'connect' | 'disconnect'
    /** While the port is mid-open there is nothing sensible to interrupt. */
    disabled?: boolean
  }
  /** Note under the device card, when the state needs explaining. */
  note?: string
  /** The note ends with a link to Settings › Connection, where auto-connect is switched. */
  noteSettingsLink?: boolean
}

/** A failure to open that means another program holds the port. */
function isBusy(detail?: string): boolean {
  return !!detail && /busy|denied|in use|access/i.test(detail)
}

export function deviceView(
  state: DeviceState,
  opts: { port?: string; detail?: string; autoConnect: boolean }
): DeviceView {
  const port = opts.port ?? 'the Gateway port'
  const disconnect = { label: 'Disconnect', action: 'disconnect' } as const
  const connect = { label: 'Connect', action: 'connect' } as const
  const nodesDown = 'Connect the Gateway to see node status — it is reported over the device link.'
  switch (state) {
    case 'connected':
      return {
        cls: 'devind--on',
        label: 'Gateway',
        chip: 'Connected',
        tip: `Gateway connected · ${port}`,
        // The popover shows the Gateway's health instead (#94); the port is in the tooltip and on
        // the Connection tab.
        popMeta: '',
        portRow: port,
        nodesHint: '',
        button: disconnect
      }
    case 'scanning':
      return {
        cls: 'devind--scan',
        label: 'Scanning',
        chip: 'Scanning…',
        tip: 'Looking for the Gateway…',
        popMeta: 'Looking for the Gateway…',
        portRow: 'scanning…',
        nodesHint: 'Reconnecting to the Gateway…',
        button: { ...disconnect, disabled: true }
      }
    case 'reconnecting':
      return {
        cls: 'devind--retry',
        label: 'Reconnecting',
        chip: 'Reconnecting',
        tip: 'Link dropped — reopening the port (a relay keeps running)',
        popMeta: 'Link dropped — reopening the port. A running relay keeps going.',
        portRow: 'reconnecting…',
        nodesHint: 'Reconnecting to the Gateway…',
        button: disconnect
      }
    case 'no-device':
      return {
        cls: '',
        label: 'No device',
        chip: 'No device',
        tip: 'No Gateway plugged in — it connects as soon as you plug it in',
        popMeta: 'Nothing plugged in — it connects as soon as you plug it in.',
        portRow: 'waiting for the board…',
        nodesHint: nodesDown,
        button: disconnect
      }
    case 'disconnected':
      return {
        cls: 'devind--off',
        label: 'Disconnected',
        chip: 'Disconnected',
        tip: opts.autoConnect
          ? 'Port released — press Connect on the Connection tab'
          : 'Connect automatically is off — press Connect on the Connection tab',
        popMeta: opts.autoConnect
          ? 'Port released — other tools can use it until you press Connect.'
          : 'Automatic connection is off — press Connect when you need the link.',
        portRow: 'released',
        nodesHint: 'Device link released — press Connect to see node status.',
        button: connect,
        note: opts.autoConnect
          ? 'Port released — other tools can use it. It stays closed through a replug until you press Connect or restart the app.'
          : 'Automatic connection is off, so the port stays free for other tools — press Connect when you need the link. Change it in',
        noteSettingsLink: !opts.autoConnect
      }
    case 'error': {
      const busy = isBusy(opts.detail)
      return {
        cls: 'devind--err',
        label: 'Error',
        chip: 'Error',
        tip: `Can't open ${port}${opts.detail ? ` — ${opts.detail}` : ''}`,
        popMeta: busy
          ? `Port busy — another app has ${port} open. Close it, then Retry.`
          : `${port} would not open${opts.detail ? `: ${opts.detail}` : ''}. Retry, or replug the board.`,
        portRow: `${port} · ${busy ? 'busy' : 'error'}`,
        nodesHint: "Can't open the Gateway port — see the device card.",
        button: { label: 'Retry', action: 'connect' },
        note: busy
          ? `${port} is open in another app (socat?). Close it, then Retry.`
          : `${port} would not open${opts.detail ? `: ${opts.detail}` : ''}. Retry, or replug the board.`
      }
    }
  }
}

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
 * Tooltip on the relay pill: where the DCS-BIOS stream stands. A relay keeps running through a
 * drop, so while it is waiting the tooltip says what for, rather than looking broken.
 */
export function relayTip(
  opts: RelayOpts & { deviceLabel: string; endpoint: string; replayFile?: string }
): string {
  if (opts.mode === 'replay') {
    if (!opts.relaying) return 'Replay stopped — click to play'
    if (opts.stream === 'ended') return 'Replay · ended — click to stop'
    const file = opts.replayFile?.split(/[/\\]/).pop()
    return `Replay · playing${file ? ` ${file}` : ''} — click to stop`
  }
  if (!opts.relaying) return 'DCS-BIOS stream stopped — click to start'
  if (waitingForDevice(opts)) {
    return `Relaying — waiting for the Gateway (device link ${opts.deviceLabel.toLowerCase()}). Resumes when it connects — click to stop`
  }
  if (waitingForDcs(opts)) {
    return `Relaying — waiting for DCS-BIOS (${opts.stream ?? 'connecting'}) · ${opts.endpoint} — click to stop`
  }
  return `DCS-BIOS stream · connected · ${opts.endpoint} — click to stop`
}

/**
 * The line under the Connection tab's Start / Stop button: what a running relay is waiting for.
 */
export function relayNote(opts: RelayOpts): { text: string; info: boolean } | undefined {
  if (waitingForDevice(opts)) {
    return { text: 'Relaying — waiting for the Gateway. Resumes when it connects.', info: false }
  }
  if (waitingForDcs(opts)) {
    return {
      text: `Relaying — waiting for DCS-BIOS (${opts.stream ?? 'connecting'}).`,
      info: false
    }
  }
  if (opts.relaying && opts.mode === 'replay' && opts.stream === 'ended') {
    return { text: 'Replay ended — Stop, or load another capture.', info: false }
  }
  return undefined
}

/**
 * Start is refused while a mode that delivers to the board has no board to deliver to: Bridge, and
 * Replay driving the SimGateway. Monitor and an undriven Replay never touch it. Mirrors main's
 * check in Session.start(), which is the one that actually enforces it.
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

/** Why Start is unavailable, for the pill tooltip and the note under the Start button. */
export function startBlockedReason(mode: SourceMode): string {
  return mode === 'replay'
    ? 'Connect the Gateway to play the capture to it, or turn Drive Gateway off.'
    : 'Connect the Gateway to start the relay.'
}

/** Body of the callout a blocked Relay pill answers a click with. */
export function startBlockedCallout(mode: SourceMode): string {
  return mode === 'replay'
    ? "The Gateway isn't connected, and Drive Gateway plays the capture to it. Connect first, or turn Drive off."
    : "The Gateway isn't connected, and the relay delivers to it. Connect first."
}
