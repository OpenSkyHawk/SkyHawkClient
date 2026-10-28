// gateway's intents: Connect / Disconnect and the Serial tab's monitor. app/ipc.ts registers them,
// in its order (they are not registered together).
import type { IpcRegistrar } from '@shared/app'
import { GATEWAY_CTRL } from '@shared/gateway'
import type { GatewayConnection } from './gateway-connection'
import type { SerialTrafficMonitor } from './serial-traffic-monitor'

export interface GatewayIpcDeps {
  connection: GatewayConnection
  serialMonitor: SerialTrafficMonitor
}

export function registerGatewayIpc(ipc: IpcRegistrar, deps: GatewayIpcDeps): void {
  const { connection, serialMonitor } = deps
  ipc.handle(GATEWAY_CTRL.deviceConnect, () => connection.connect())
  ipc.handle(GATEWAY_CTRL.deviceDisconnect, () => connection.disconnect())
  ipc.handle(GATEWAY_CTRL.serialMonitor, (_e, on: boolean) => serialMonitor.setSerialMonitor(on))
}
