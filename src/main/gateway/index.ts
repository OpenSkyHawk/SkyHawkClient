// gateway: the SimGateway USB link. Exports only what other topics use (arch-phase0-v2 §2.1).
export {
  GatewayConnection,
  type CalFrameFilter,
  type GatewayConnectionDeps,
  type LinkRider,
  type LinkTimer
} from './gateway-connection'
export { DeviceLineTap, type DeviceLine, type NodeLineSink } from './device-line-tap'
export { SerialTrafficMonitor } from './serial-traffic-monitor'
export { GatewayWatch } from './gateway-health'
export { encodeExportFrame } from './link-framing'
export { deviceEvent } from './link-events'
export { listSerialPorts } from './serial-bridge'
export { registerGatewayIpc } from './ipc'
