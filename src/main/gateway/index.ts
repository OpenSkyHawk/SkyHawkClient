// gateway: the SimGateway USB link. Exports only what other topics use (arch-phase0-v2 §2.1).
export { DeviceLink, type DeviceLinkDeps } from './device-link'
export { listSerialPorts } from './serial-bridge'
