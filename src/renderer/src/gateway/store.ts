// The device link and the raw serial monitor as main pushes them (R3.4b: the gateway slice of the
// old single store, cut verbatim). The IPC adapter binds the intents and delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import {
  DEVICE_IDLE,
  type DeviceState,
  type DeviceStatusPush,
  type GatewayStatus,
  type LinkAction,
  type SerialFrame
} from '@shared/gateway'

export interface SerialRow extends SerialFrame {
  id: number
}

const MAX_SERIAL = 2000

export interface GatewayState {
  // live link state
  deviceState: DeviceState
  devicePort?: string
  /** Why the link is in `error` — e.g. another program holds the port. */
  deviceDetail?: string
  /** The Gateway's own health (#94); only while connected. */
  deviceGateway?: GatewayStatus
  /** The link is up, as main concludes it (`device:status`, R3.3). */
  linkUp: boolean
  /** The board is plugged in as far as the link can tell: HID reports can arrive (#74). */
  boardPresent: boolean
  /** The port would not open because another program holds it. */
  deviceBusy: boolean
  /** The device card's and the popover's button, as main offers it (`device:status`, R3.4a). */
  deviceAction: LinkAction
  /** A roster request can go out: Connection's Refresh (`device:status`, R3.4a). */
  canRefresh: boolean
  /**
   * When the device link last went down after being up — "last known" time on the Cockpit. Main
   * stamps it (`device:status`, R3.3).
   */
  linkDownAt?: number

  // raw serial monitor
  /** The Serial tab's monitor, as main reports this page last set it (`device:status`, R3.3). */
  serialMonitor: boolean
  serialLog: SerialRow[]
  private_serialSeq: number

  /** Open the device link now (also the Retry after an error). */
  connectDevice: () => void
  /** Release the serial port until connectDevice(), even through a replug. */
  disconnectDevice: () => void
  setSerialMonitor: (on: boolean) => void
  clearSerial: () => void
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindGateway(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

/** The store fields `device:status` sets — on each push, and from the rehydrate bundle. */
function linkState(
  d: DeviceStatusPush
): Pick<
  GatewayState,
  | 'deviceState'
  | 'devicePort'
  | 'deviceDetail'
  | 'deviceGateway'
  | 'linkUp'
  | 'boardPresent'
  | 'deviceBusy'
  | 'deviceAction'
  | 'canRefresh'
  | 'linkDownAt'
  | 'serialMonitor'
> {
  return {
    deviceState: d.state,
    devicePort: d.portPath,
    deviceDetail: d.detail,
    deviceGateway: d.gateway,
    linkUp: d.linkUp,
    boardPresent: d.boardPresent,
    deviceBusy: d.busy,
    deviceAction: d.action,
    canRefresh: d.canRefresh,
    linkDownAt: d.linkDownAt,
    serialMonitor: d.serialMonitor
  }
}

export const useGatewayStore = create<GatewayState>((set) => ({
  ...linkState(DEVICE_IDLE),

  serialLog: [],
  private_serialSeq: 0,

  connectDevice: () => {
    void api()?.connectDevice()
  },

  disconnectDevice: () => {
    void api()?.disconnectDevice()
  },

  // Main pushes the flag back on `device:status` (R3.3).
  setSerialMonitor: (on) => {
    void api()?.setSerialMonitor(on)
  },

  clearSerial: () => set({ serialLog: [] })
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const gatewayFromMain = {
  /** `device:status`, and the rehydrate bundle's `device`. */
  status: (d: DeviceStatusPush): void => useGatewayStore.setState(linkState(d)),

  /** `serial:traffic`. */
  serialTraffic: (frames: SerialFrame[]): void => {
    const s = useGatewayStore.getState()
    let seq = s.private_serialSeq
    const mapped: SerialRow[] = frames.map((f) => ({ id: seq++, ...f }))
    useGatewayStore.setState({
      serialLog: [...mapped.reverse(), ...s.serialLog].slice(0, MAX_SERIAL),
      private_serialSeq: seq
    })
  }
}
