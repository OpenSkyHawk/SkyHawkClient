import { useConfigStore } from '../../config'
import { DevicePopover as LinkPopover } from '../../gateway'

/** The title-bar Device popover (gateway), with Settings' auto-connect it words a state by. */
export function DevicePopover() {
  const autoConnect = useConfigStore((s) => s.autoConnect)
  return <LinkPopover autoConnect={autoConnect} />
}
