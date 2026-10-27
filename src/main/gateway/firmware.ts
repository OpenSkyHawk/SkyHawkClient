// Firmware releases as the boards report them (#171), pure. Every board sends its release in its
// status row (v4); 0.0.0 means "not reported". The Gateway's own row carries the bridge's build. A
// major the client was not synced against may not read right (within a major firmware only
// appends, D22), and boards on different majors don't work together on the bus.
import { FIRMWARE_RELEASE } from '@shared/firmware'
import type { FirmwareVersion, GatewayFirmware } from '@shared/gateway'
import type { NodeStatus } from '@shared/nodes'

/** The release a status row reports; null for 0.0.0 (not reported) or no row. */
export function reportedVersion(row: NodeStatus | undefined): FirmwareVersion | null {
  if (!row || (row.fwMajor === 0 && row.fwMinor === 0 && row.fwPatch === 0)) return null
  return { major: row.fwMajor, minor: row.fwMinor, patch: row.fwPatch }
}

/** The Gateway's firmware from its own row, judged against the release this client supports. */
export function gatewayFirmware(row: NodeStatus): GatewayFirmware {
  const version = reportedVersion(row)
  const supportedMajor = FIRMWARE_RELEASE.major
  return { version, tooNew: !!version && version.major > supportedMajor, supportedMajor }
}

/**
 * A board on another major than the Gateway: both majors, else undefined. Never while either side
 * has not reported its release.
 */
export function majorMismatch(
  board: FirmwareVersion | null,
  gateway: GatewayFirmware | undefined
): { board: number; gateway: number } | undefined {
  const gw = gateway?.version
  if (!board || !gw || board.major === gw.major) return undefined
  return { board: board.major, gateway: gw.major }
}
