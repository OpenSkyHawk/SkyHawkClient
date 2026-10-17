// What the link's state means (pure, no Node/Electron deps): up, the board plugged in, the port held
// by another program, and the facts `device:status` carries to the renderer (R3.3). Moved from the
// renderer and from the gateway contract (isLinkUp) so the
// link's owner decides them once; the renderer only reads what is pushed.
import type { DeviceLinkFacts, DeviceState, DeviceStatus, LinkAction } from '@shared/gateway'

/**
 * Whether the device link is up. The single definition every consumer keys on — calibration,
 * the nodes card, the Cockpit tab (#63) — so none of them invents its own.
 *
 * While it is down, link-scoped data (node model, telemetry) is left at its last state and
 * should be shown dimmed; there is no separate "stale" signal. HID is not link-scoped: the
 * joystick is read alongside DCS and keeps reporting with the serial port released (#74).
 */
export function isLinkUp(state: DeviceState): boolean {
  return state === 'connected'
}

/**
 * Whether the board can be sending HID reports at all, judged from the serial link's state.
 *
 * The joystick is a second interface on the same USB device and is read alongside DCS, so it
 * does not need the serial port open (#69, #74). What it needs is the board plugged in, and the
 * link state is the only evidence of that the renderer has:
 *
 *   connected            — open, so plugged in
 *   error                — typically "port busy": another tool holds the CDC, the board is there
 *   disconnected         — released by Disconnect or with auto-connect off; normally still plugged
 *   no-device / scanning / reconnecting — not found, or not yet: nothing can arrive
 *
 * The one case this misreads is an unplug while auto-connect is off: the link was already
 * released, nobody is looking for the port, so it stays `disconnected` and the card ages to
 * "quiet" instead of saying "no link". Nothing on the serial side can see that unplug, and the
 * HID reader does not reliably either — it is the accepted cost of not polling for the board.
 */
const BOARD_PRESENT: ReadonlySet<DeviceState> = new Set(['connected', 'error', 'disconnected'])

/** The board is attached, as far as the link can tell (BOARD_PRESENT). */
export function isBoardPresent(state: DeviceState): boolean {
  return BOARD_PRESENT.has(state)
}

/** A failure to open that means another program holds the port. */
export function isBusy(detail?: string): boolean {
  return !!detail && /busy|denied|in use|access/i.test(detail)
}

/**
 * The link's one action in each state (R3.4a: the renderer's deviceView table): Connect when
 * released, Retry after an error, Disconnect otherwise — not while the port is mid-open.
 */
export function linkAction(state: DeviceState): LinkAction {
  const disconnect = { offer: 'disconnect', intent: 'disconnect' } as const
  const connect = { offer: 'connect', intent: 'connect' } as const
  switch (state) {
    case 'connected':
      return disconnect
    case 'scanning':
      // While the port is mid-open there is nothing sensible to interrupt.
      return { ...disconnect, disabled: true }
    case 'reconnecting':
      return disconnect
    case 'no-device':
      return disconnect
    case 'disconnected':
      return connect
    case 'error':
      return { offer: 'retry', intent: 'connect' }
  }
}

/**
 * "When the link last went down after being up", as the renderer's store kept it for the
 * Cockpit's "last known" time, judged per `device:status` push: stamped on an up → down change,
 * cleared while up, otherwise left as it was. The page's own: a renderer that (re)loads starts
 * with none until the next drop (N1), so `pageLoaded` forgets it.
 */
export class LinkDownClock {
  private wasUp = false
  private at?: number

  constructor(private readonly now: () => number = Date.now) {}

  /** One `device:status` push: the renderer's old handler, step for step. */
  pushed(state: DeviceState): number | undefined {
    const wasUp = this.wasUp
    if (wasUp && !isLinkUp(state)) this.at = this.now()
    else if (isLinkUp(state)) this.at = undefined
    this.wasUp = isLinkUp(state)
    return this.at
  }

  /** The time as the last push carried it. */
  get value(): number | undefined {
    return this.at
  }

  /**
   * A renderer (re)loaded: its store started with no time, and took the link's state from the
   * rehydrate bundle (`relay:status`), which is where its next push is judged from.
   */
  pageLoaded(state: DeviceState): void {
    this.at = undefined
    this.wasUp = isLinkUp(state)
  }
}

/**
 * What `device:status` carries besides the status itself. `canRefresh` is NodeHub's (its roster
 * request guard), handed in: none without a node layer.
 */
export function linkFacts(
  status: DeviceStatus,
  page: { linkDownAt?: number; serialMonitor: boolean },
  canRefresh = false
): DeviceLinkFacts {
  return {
    linkUp: isLinkUp(status.state),
    boardPresent: isBoardPresent(status.state),
    busy: isBusy(status.detail),
    ...(page.linkDownAt !== undefined ? { linkDownAt: page.linkDownAt } : {}),
    serialMonitor: page.serialMonitor,
    action: linkAction(status.state),
    canRefresh
  }
}
