// gateway (R3.4b): the device link and the serial monitor as main pushes them; the title-bar
// Device popover, the Connection tab's device card and the Serial tab.
export {
  bindGateway,
  gatewayFromMain,
  useGatewayStore,
  type GatewayState,
  type SerialRow
} from './store'
export { DevicePopover } from './DevicePopover'
export { DeviceCard } from './DeviceCard'
export { Serial as SerialTab } from './Serial'
export { gatewayView } from './gateway-view'
export { deviceView } from './link-view'
