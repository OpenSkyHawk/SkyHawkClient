// gateway: the SimGateway USB link. Exports only what other topics use (arch-phase0-v2 §2.1).
export {
  DeviceLink,
  type CalFrameFilter,
  type DeviceLinkDeps,
  type LinkRider,
  type LinkTimer
} from './device-link'
export { deviceEvent } from './link-events'
export { findSimGatewayPort, listSerialPorts } from './serial-bridge'
