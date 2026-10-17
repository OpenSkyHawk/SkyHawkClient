import type { DeviceState, LinkAction } from '@shared/gateway'

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
