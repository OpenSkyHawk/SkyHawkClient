// The Firmware button, sheet and Overview banner (#173): every board against the release, decided
// once here so the button's count, the sheet's *Needs attention* filter and the banner agree.
//
// The versions are what each side reports: the Gateway's USB side in HELLO_ACK (hid/calibration hands
// it to NodeHub), its cockpit side in its own `_NODE_STATUS` row, and every board in its row (v4,
// #171). The release is the newest one saved on this computer (releases' `target()`): its version
// order and its images are releases' rules, handed in with it.
//
// The chips are the design's `fwInfo` (CockpitMap.dc.html:817-858), in its order. Updating, stuck,
// app unstable (#175) and not responding (#187) join it later.
import type { DeviceStatus, FirmwareVersion } from '@shared/gateway'
import type {
  FirmwareBanner,
  FirmwareRow,
  FirmwareSheet,
  FirmwareStatus,
  NodeView
} from '@shared/nodes'
import type { ReleaseTarget } from '@shared/releases'
import { noBootloader, reportedVersion } from '../../gateway'

/** What the snapshot reads besides the node views and the link. */
export interface FirmwareInputs {
  /** The USB side's release from HELLO_ACK this connect; undefined until it answers. */
  usb?: FirmwareVersion
  /** The newest saved release; undefined while nothing is saved. */
  release?: ReleaseTarget
}

const text = (v: FirmwareVersion): string => `${v.major}.${v.minor}.${v.patch}`
const isZero = (v: FirmwareVersion) => v.major === 0 && v.minor === 0 && v.patch === 0

/** The statuses counted in *Needs attention* (the design's `need`). */
const ATTENTION: ReadonlySet<FirmwareStatus> = new Set(['update', 'mismatch', 'manual'])

/** A reported version against the release: no release, no image, or the version order. */
function againstRelease(
  version: string,
  release: ReleaseTarget | undefined,
  image: Parameters<ReleaseTarget['hasImage']>[0]
): FirmwareStatus {
  if (!release) return 'no-release'
  if (!release.hasImage(image)) return 'custom'
  const c = release.compare(version)
  return c < 0 ? 'update' : c > 0 ? 'newer' : 'ok'
}

const row = (r: Omit<FirmwareRow, 'attention'>): FirmwareRow => ({
  ...r,
  attention: ATTENTION.has(r.status)
})

/** The Gateway's USB side: its HELLO_ACK this connect. */
function usbRow(live: boolean, f: FirmwareInputs): FirmwareRow {
  const base = { key: 'usb', side: 'usb' as const, name: 'Gateway · USB side' }
  if (!live || !f.usb) return row({ ...base, status: 'not-reported' })
  if (isZero(f.usb)) return row({ ...base, status: 'not-reported', notReported: true })
  const version = text(f.usb)
  const status = againstRelease(version, f.release, { side: 'usb' })
  // Behind the saved release, which has its image: the USB side's own update (#173).
  return row({
    ...base,
    version,
    status,
    ...(status === 'update' && { action: 'update' as const })
  })
}

/**
 * The Gateway's cockpit side: its own status row. Compared with the release like any board; the
 * bundle the USB side carries is #187's compare.
 */
function cockpitRow(live: boolean, device: DeviceStatus, f: FirmwareInputs): FirmwareRow {
  const base = { key: 'cockpit', side: 'cockpit' as const, name: 'Gateway · cockpit side' }
  const fw = device.gateway?.firmware
  if (!live || !fw) return row({ ...base, status: 'not-reported' })
  if (!fw.version) return row({ ...base, status: 'not-reported', notReported: true })
  const version = text(fw.version)
  if (fw.noBootloader) return row({ ...base, version, status: 'manual' })
  return row({ ...base, version, status: againstRelease(version, f.release, { nodeId: 0 }) })
}

/** A board in your cockpit, from its status row. */
function boardRow(v: NodeView, live: boolean, f: FirmwareInputs): FirmwareRow {
  const e = v.entry
  const base = { key: String(e.nodeId), nodeId: e.nodeId, name: e.name, kind: e.kind }
  const reported = reportedVersion(e.status)
  const version = reported ? text(reported) : undefined
  // While the link is down nothing on the bus is known: not reported, not offline (as drawn).
  if (!live || e.availability === 'unknown') return row({ ...base, status: 'not-reported' })
  if (e.notSeen || e.availability === 'offline') {
    return row({ ...base, status: 'off', ...(version && { version }) })
  }
  if (!version) {
    return row({
      ...base,
      status: 'not-reported',
      ...(v.firmware.notReported && { notReported: true })
    })
  }
  if (noBootloader(e.status)) return row({ ...base, version, status: 'manual' })
  if (v.firmware.mismatch) {
    return row({ ...base, version, status: 'mismatch', gatewayMajor: v.firmware.mismatch.gateway })
  }
  return row({
    ...base,
    version,
    status: againstRelease(version, f.release, { nodeId: e.nodeId })
  })
}

/**
 * The sheet: the Gateway's USB side, its cockpit side, then the boards in your cockpit (not the
 * new ones on the bus) — those needing attention first, then by NODE_ID.
 */
export function firmwareSheet(
  views: NodeView[],
  live: boolean,
  device: DeviceStatus,
  f: FirmwareInputs
): FirmwareSheet {
  const boards = views
    .filter((v) => v.entry.source !== 'new')
    .map((v) => boardRow(v, live, f))
    .sort((a, b) => Number(b.attention) - Number(a.attention) || a.nodeId! - b.nodeId!)
  const rows = [usbRow(live, f), cockpitRow(live, device, f), ...boards]
  return {
    ...(f.release && { target: f.release.version }),
    rows,
    attention: rows.filter((r) => r.attention).length,
    allCurrent: !!f.release && rows.every((r) => r.status === 'ok')
  }
}

/**
 * The Overview's banner (OV:81): what can update, by kind — the Gateway (either side), then PDUs,
 * then other boards with a release image — and the boards with no bootloader that are behind.
 * Custom firmware isn't counted. None while nothing is behind.
 */
export function firmwareBanner(
  sheet: FirmwareSheet,
  release: ReleaseTarget | undefined
): FirmwareBanner | null {
  if (!release) return null
  const updates = sheet.rows.filter((r) => r.status === 'update')
  const banner: FirmwareBanner = {
    version: release.version,
    gateway: updates.some((r) => r.side),
    pdus: updates.filter((r) => r.kind === 'pdu').length,
    boards: updates.filter((r) => r.nodeId !== undefined && r.kind !== 'pdu').length,
    manual: sheet.rows.filter((r) => r.status === 'manual' && release.compare(r.version!) < 0)
      .length
  }
  return banner.gateway || banner.pdus || banner.boards || banner.manual ? banner : null
}
