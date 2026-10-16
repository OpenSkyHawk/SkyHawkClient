import type { DeviceState, StreamState } from '@shared/ipc'
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
  /** Detail line in the title-bar device popover. */
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
  const port = opts.port ?? 'the SimGateway port'
  const disconnect = { label: 'Disconnect', action: 'disconnect' } as const
  const connect = { label: 'Connect', action: 'connect' } as const
  const nodesDown =
    'Connect the SimGateway to see node status — it is reported over the device link.'
  switch (state) {
    case 'connected':
      return {
        cls: 'devind--on',
        label: 'SimGateway',
        chip: 'Connected',
        tip: `SimGateway connected · ${port}`,
        popMeta: `${port}${opts.autoConnect ? ' · opened automatically' : ''}`,
        portRow: port,
        nodesHint: '',
        button: disconnect
      }
    case 'scanning':
      return {
        cls: 'devind--scan',
        label: 'Scanning',
        chip: 'Scanning…',
        tip: 'Looking for the SimGateway…',
        popMeta: 'Looking for the SimGateway…',
        portRow: 'scanning…',
        nodesHint: 'Reconnecting to the SimGateway…',
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
        nodesHint: 'Reconnecting to the SimGateway…',
        button: disconnect
      }
    case 'no-device':
      return {
        cls: '',
        label: 'No device',
        chip: 'No device',
        tip: 'No SimGateway plugged in — it connects as soon as you plug it in',
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
        nodesHint: "Can't open the SimGateway port — see the device card.",
        button: { label: 'Retry', action: 'connect' },
        note: busy
          ? `${port} is open in another app (socat?). Close it, then Retry.`
          : `${port} would not open${opts.detail ? `: ${opts.detail}` : ''}. Retry, or replug the board.`
      }
    }
  }
}

/**
 * Tooltip on the relay pill: where the DCS-BIOS stream stands. A relay keeps running through a
 * device drop, so while relaying with the link down it says so rather than looking broken.
 */
export function relayTip(opts: {
  mode: SourceMode
  relaying: boolean
  stream?: StreamState
  deviceState: DeviceState
  deviceLabel: string
  endpoint: string
  replayFile?: string
}): string {
  if (opts.mode === 'replay') {
    if (!opts.relaying) return 'Replay stopped — click to play'
    if (opts.stream === 'ended') return 'Replay · ended — click to stop'
    const file = opts.replayFile?.split(/[/\\]/).pop()
    return `Replay · playing${file ? ` ${file}` : ''} — click to stop`
  }
  if (!opts.relaying) return 'DCS-BIOS stream stopped — click to start'
  const stream = opts.stream ?? 'connecting'
  // Only Bridge carries the stream over the device; Monitor never touches it.
  const device =
    opts.mode === 'bridge' && opts.deviceState !== 'connected'
      ? ` — device link ${opts.deviceLabel.toLowerCase()}, relay keeps running`
      : ''
  return `DCS-BIOS stream · ${stream}${device} · ${opts.endpoint} — click to stop`
}
