// Firmware releases as the boards report them (#171), pure. Every board sends its release in its
// status row (v4); 0.0.0 means "not reported", and a board with no row has told us nothing. The
// Gateway's own row carries the bridge's build. Within a major firmware only appends (D22), so a
// newer major than this client supports may not read right, and boards on different majors don't
// work together on the bus.
import type { FirmwareVersion, GatewayFirmware } from '@shared/gateway'
import type { NodeStatus } from '@shared/nodes'

/**
 * The firmware major this client's parser is written for: the client's own claim (D22), not a
 * synced firmware value. An upper limit only: an older major is judged by the release compare and
 * the board-vs-Gateway mismatch, never refused here.
 */
export const SUPPORTED_FIRMWARE_MAJOR = 1

/**
 * The release a status row reports; null for 0.0.0 (not reported) or no row.
 * `versionNotReported` tells those two apart.
 */
export function reportedVersion(row: NodeStatus | undefined): FirmwareVersion | null {
  if (!row || (row.fwMajor === 0 && row.fwMinor === 0 && row.fwPatch === 0)) return null
  return { major: row.fwMajor, minor: row.fwMinor, patch: row.fwPatch }
}

/** There is a row and it reads 0.0.0. No row is no data, not "not reported". */
export function versionNotReported(row: NodeStatus | undefined): boolean {
  return !!row && reportedVersion(row) === null
}

/** A release on a newer major than this client supports. */
export function newerThanClient(v: FirmwareVersion): boolean {
  return v.major > SUPPORTED_FIRMWARE_MAJOR
}

/** The Gateway's firmware from its own row, judged against the major this client supports. */
export function gatewayFirmware(row: NodeStatus): GatewayFirmware {
  const version = reportedVersion(row)
  return {
    version,
    tooNew: !!version && newerThanClient(version),
    supportedMajor: SUPPORTED_FIRMWARE_MAJOR
  }
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
