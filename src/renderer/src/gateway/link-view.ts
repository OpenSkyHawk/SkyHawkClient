import type { DeviceState, LinkAction } from '@shared/gateway'
import type {
  EndpointLabel,
  RelayFacts,
  RelaySurfaces,
  RelayTip,
  RelayWaiting,
  StreamState
} from '@shared/dcs'

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
  /** Note under the device card, when the state needs explaining. */
  note?: string
  /** The note ends with a link to Settings › Connection, where auto-connect is switched. */
  noteSettingsLink?: boolean
}

/**
 * `busy`: main's verdict that another program holds the port (`device:status`, R3.3); it only
 * changes how an `error` reads.
 */
export function deviceView(
  state: DeviceState,
  opts: { port?: string; detail?: string; busy?: boolean; autoConnect: boolean }
): DeviceView {
  const port = opts.port ?? 'the Gateway port'
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
        nodesHint: ''
      }
    case 'scanning':
      return {
        cls: 'devind--scan',
        label: 'Scanning',
        chip: 'Scanning…',
        tip: 'Looking for the Gateway…',
        popMeta: 'Looking for the Gateway…',
        portRow: 'scanning…',
        nodesHint: 'Reconnecting to the Gateway…'
      }
    case 'reconnecting':
      return {
        cls: 'devind--retry',
        label: 'Reconnecting',
        chip: 'Reconnecting',
        tip: 'Link dropped — reopening the port (a relay keeps running)',
        popMeta: 'Link dropped — reopening the port. A running relay keeps going.',
        portRow: 'reconnecting…',
        nodesHint: 'Reconnecting to the Gateway…'
      }
    case 'no-device':
      return {
        cls: '',
        label: 'No device',
        chip: 'No device',
        tip: 'No Gateway plugged in — it connects as soon as you plug it in',
        popMeta: 'Nothing plugged in — it connects as soon as you plug it in.',
        portRow: 'waiting for the board…',
        nodesHint: nodesDown
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
        note: opts.autoConnect
          ? 'Port released — other tools can use it. It stays closed through a replug until you press Connect or restart the app.'
          : 'Automatic connection is off, so the port stays free for other tools — press Connect when you need the link. Change it in',
        noteSettingsLink: !opts.autoConnect
      }
    case 'error': {
      const busy = !!opts.busy
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
        note: busy
          ? `${port} is open in another app (socat?). Close it, then Retry.`
          : `${port} would not open${opts.detail ? `: ${opts.detail}` : ''}. Retry, or replug the board.`
      }
    }
  }
}

/** The device card's and the Device popover's button, for the action main offers (R3.4a). */
export interface LinkButton {
  label: 'Connect' | 'Disconnect' | 'Retry'
  action: LinkAction['intent']
  disabled?: boolean
}

const LINK_LABEL: Record<LinkAction['offer'], LinkButton['label']> = {
  connect: 'Connect',
  disconnect: 'Disconnect',
  retry: 'Retry'
}

/** The Connect / Disconnect / Retry button: main's action (link-state linkAction), worded. */
export function linkButton(a: LinkAction): LinkButton {
  return {
    label: LINK_LABEL[a.offer],
    action: a.intent,
    ...(a.disabled ? { disabled: true } : {})
  }
}

/** The relay's surfaces for the on/off as shown — the pending Start or Stop included (R3.3). */
export function relaySide(f: RelayFacts, relaying: boolean): RelaySurfaces {
  return relaying ? f.running : f.stopped
}

/** An endpoint as a surface labels it: main's choice, filled in with the host and port typed. */
export function endpointText(label: EndpointLabel, host: string, port: string): string {
  return 'text' in label ? label.text : `${host}:${port}${label.hostPort.suffix}`
}

/**
 * Tooltip on the relay pill: where the DCS-BIOS stream stands, for the branch main picked
 * (relay-rules relayTip). A relay keeps running through a drop, so while it is waiting the
 * tooltip says what for, rather than looking broken.
 */
export function relayTip(opts: {
  tip: RelayTip
  stream?: StreamState
  deviceLabel: string
  endpoint: string
  replayFile?: string
}): string {
  switch (opts.tip) {
    case 'replay-stopped':
      return 'Replay stopped — click to play'
    case 'replay-ended':
      return 'Replay · ended — click to stop'
    case 'replay-playing': {
      const file = opts.replayFile?.split(/[/\\]/).pop()
      return `Replay · playing${file ? ` ${file}` : ''} — click to stop`
    }
    case 'stopped':
      return 'DCS-BIOS stream stopped — click to start'
    case 'waiting-device':
      return `Relaying — waiting for the Gateway (device link ${opts.deviceLabel.toLowerCase()}). Resumes when it connects — click to stop`
    case 'waiting-dcs':
      return `Relaying — waiting for DCS-BIOS (${opts.stream ?? 'connecting'}) · ${opts.endpoint} — click to stop`
    case 'delivering':
      return `DCS-BIOS stream · connected · ${opts.endpoint} — click to stop`
  }
}

/**
 * The line under the Connection tab's Start / Stop button: what a running relay is waiting for,
 * as main judged it (relay-rules relayNote).
 */
export function relayNote(
  waiting: RelayWaiting,
  stream?: StreamState
): { text: string; info: boolean } | undefined {
  if (waiting === 'device') {
    return { text: 'Relaying — waiting for the Gateway. Resumes when it connects.', info: false }
  }
  if (waiting === 'dcs') {
    return {
      text: `Relaying — waiting for DCS-BIOS (${stream ?? 'connecting'}).`,
      info: false
    }
  }
  if (waiting === 'replay-ended') {
    return { text: 'Replay ended — Stop, or load another capture.', info: false }
  }
  return undefined
}

/**
 * Why Start is unavailable, for the pill tooltip and the note under the Start button: by the
 * mode main says needs the board (relay-rules startBlocked).
 */
export function startBlockedReason(reason: 'bridge' | 'replay'): string {
  return reason === 'replay'
    ? 'Connect the Gateway to play the capture to it, or turn Drive Gateway off.'
    : 'Connect the Gateway to start the relay.'
}

/** Body of the callout a blocked Relay pill answers a click with. */
export function startBlockedCallout(reason: 'bridge' | 'replay'): string {
  return reason === 'replay'
    ? "The Gateway isn't connected, and Drive Gateway plays the capture to it. Connect first, or turn Drive off."
    : "The Gateway isn't connected, and the relay delivers to it. Connect first."
}
