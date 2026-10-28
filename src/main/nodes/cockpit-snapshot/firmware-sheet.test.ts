// #173: the Firmware sheet's rows, its *Needs attention* count and the Overview's firmware banner,
// from the reported versions (HELLO_ACK, the node-0 row, the boards' rows) against the release.
import { describe, expect, it } from 'vitest'
import type { DeviceStatus, FirmwareVersion } from '@shared/gateway'
import type { FirmwareRow, NodeModelEntry } from '@shared/nodes'
import type { ReleaseTarget } from '@shared/releases'
import { modelNode as node, nodeModel as model, nodeStatus } from '../../../test-fixtures/nodes'
import { gatewayStatus } from '../../gateway/gateway-health'
import { buildCockpitSnapshot } from '.'
import { firmwareBanner, firmwareSheet, type FirmwareInputs } from './firmware-sheet'
import { nodeViews } from './views'

const v = (text: string): FirmwareVersion => {
  const [major, minor, patch] = text.split('.').map(Number)
  return { major: major!, minor: minor!, patch: patch! }
}
const order = (a: string, b: string) => {
  const x = v(a)
  const y = v(b)
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

/** A saved release `version` with images for the USB side and `nodes` (0.3.0's: 0, 3, 4, 5). */
const release = (version: string, nodes = [0, 3, 4, 5], usb = true): ReleaseTarget => ({
  version,
  compare: (reported) => order(reported, version),
  hasImage: (of) => ('side' in of ? usb : nodes.includes(of.nodeId))
})

/** A board online in your cockpit, reporting `fw` with a bootloader (unless `bootloader: 0`). */
const board = (nodeId: number, fw: string, over: Partial<NodeModelEntry> = {}, bootloader = 1) => {
  const f = v(fw)
  return node(nodeId, {
    status: nodeStatus(nodeId, {
      nodeKind: 1,
      fwMajor: f.major,
      fwMinor: f.minor,
      fwPatch: f.patch,
      bootloader
    }),
    ...over
  })
}
const pdu = (nodeId: number, fw: string, over: Partial<NodeModelEntry> = {}) =>
  board(nodeId, fw, { kind: 'pdu', name: `PDU_${nodeId}`, ...over })

/**
 * The link up, the Gateway's cockpit side reporting `cockpit` (none = no node-0 row yet) with its
 * bootloader (unless `bootloader: 0`).
 */
const connected = (cockpit?: string, bootloader = 1): DeviceStatus => {
  const f = cockpit && v(cockpit)
  const gateway = gatewayStatus(
    f
      ? nodeStatus(0, {
          nodeKind: 3,
          fwMajor: f.major,
          fwMinor: f.minor,
          fwPatch: f.patch,
          bootloader
        })
      : undefined,
    false
  )
  return { state: 'connected', ...(gateway && { gateway }) }
}

function sheet(
  nodes: NodeModelEntry[],
  f: FirmwareInputs,
  device: DeviceStatus = connected('1.0.1'),
  live = true
) {
  const views = nodeViews(model(nodes), [], device.gateway?.firmware)
  return firmwareSheet(views, live, device, f)
}

const byKey = (rows: FirmwareRow[], key: string) => rows.find((r) => r.key === key)!

describe('Firmware sheet rows (#173)', () => {
  const R = release('1.0.1')

  it('the Gateway USB side, its cockpit side, then the boards: attention first, then by NODE_ID', () => {
    const s = sheet([board(9, '1.0.1'), pdu(4, '1.0.0'), board(2, '1.0.1'), pdu(3, '1.0.1')], {
      usb: v('1.0.1'),
      release: R
    })
    expect(s.rows.map((r) => r.key)).toEqual(['usb', 'cockpit', '4', '2', '3', '9'])
    expect(s.rows.slice(0, 2).map((r) => r.name)).toEqual([
      'Gateway · USB side',
      'Gateway · cockpit side'
    ])
    expect(s.target).toBe('1.0.1')
  })

  it('compares each with the release: up to date, update available, newer than the release', () => {
    const s = sheet([pdu(3, '1.0.0'), pdu(4, '1.0.2'), pdu(5, '1.0.1')], {
      usb: v('1.0.0'),
      release: R
    })
    expect(byKey(s.rows, 'usb')).toMatchObject({
      status: 'update',
      version: '1.0.0',
      attention: true
    })
    expect(byKey(s.rows, 'cockpit')).toMatchObject({ status: 'ok', version: '1.0.1' })
    expect(byKey(s.rows, '3')).toMatchObject({
      status: 'update',
      version: '1.0.0',
      attention: true
    })
    expect(byKey(s.rows, '4')).toMatchObject({
      status: 'newer',
      version: '1.0.2',
      attention: false
    })
    expect(byKey(s.rows, '5')).toMatchObject({ status: 'ok', attention: false })
    expect(s.attention).toBe(2)
    expect(s.allCurrent).toBe(false)
  })

  it('the cockpit side compares with the release, not with what the USB side carries (#187)', () => {
    const s = sheet([], { usb: v('1.0.1'), release: R }, connected('1.0.0'))
    expect(byKey(s.rows, 'cockpit')).toMatchObject({ status: 'update', version: '1.0.0' })
  })

  it('custom firmware: no image for this NODE_ID in the release (every panel group today, PDU #6)', () => {
    const s = sheet([board(2, '1.0.0'), pdu(6, '1.0.0')], { usb: v('1.0.1'), release: R })
    expect(byKey(s.rows, '2')).toMatchObject({ status: 'custom', kind: 'panel', attention: false })
    expect(byKey(s.rows, '6')).toMatchObject({ status: 'custom', kind: 'pdu', attention: false })
    // A future release with an image for the panel group compares it like any board.
    const later = sheet([board(2, '1.0.0')], { usb: v('1.0.1'), release: release('1.0.1', [0, 2]) })
    expect(byKey(later.rows, '2').status).toBe('update')
  })

  it('manual update only: bootloader 00 on a row that reports a version (#175 rule)', () => {
    const s = sheet([board(3, '1.0.0', { kind: 'pdu' }, 0)], { usb: v('1.0.1'), release: R })
    expect(byKey(s.rows, '3')).toMatchObject({
      status: 'manual',
      version: '1.0.0',
      attention: true
    })
    // Up to date and still manual: the design keeps it in Needs attention.
    const same = sheet([board(3, '1.0.1', { kind: 'pdu' }, 0)], { usb: v('1.0.1'), release: R })
    expect(byKey(same.rows, '3')).toMatchObject({ status: 'manual', attention: true })
    // 0.0.0 with bootloader 00 is not reported, never manual.
    const zero = sheet([board(3, '0.0.0', {}, 0)], { usb: v('1.0.1'), release: R })
    expect(byKey(zero.rows, '3')).toMatchObject({ status: 'not-reported', notReported: true })
  })

  it('major mismatch with the Gateway wins over the release compare (#171)', () => {
    const s = sheet([pdu(3, '0.3.0')], { usb: v('1.0.1'), release: R })
    expect(byKey(s.rows, '3')).toMatchObject({
      status: 'mismatch',
      version: '0.3.0',
      gatewayMajor: 1,
      attention: true
    })
  })

  it('offline: what it last reported, or nothing when it never reported', () => {
    const off = { availability: 'offline' as const, offlineAt: 1 }
    const s = sheet(
      [
        pdu(3, '1.0.0', off),
        node(7, { ...off, status: undefined }),
        node(8, { notSeen: true, availability: 'offline', status: undefined })
      ],
      { usb: v('1.0.1'), release: R }
    )
    expect(byKey(s.rows, '3')).toMatchObject({ status: 'off', version: '1.0.0', attention: false })
    expect(byKey(s.rows, '7')).toEqual(expect.objectContaining({ status: 'off' }))
    expect(byKey(s.rows, '7').version).toBeUndefined()
    expect(byKey(s.rows, '8').status).toBe('off')
  })

  it('not reported: no status yet, 0.0.0, no HELLO answer, no node-0 row', () => {
    const s = sheet(
      [node(2, { availability: 'unknown', status: undefined }), board(3, '0.0.0')],
      { release: R },
      connected()
    )
    expect(byKey(s.rows, 'usb')).toMatchObject({ status: 'not-reported' })
    expect(byKey(s.rows, 'usb').notReported).toBeUndefined()
    expect(byKey(s.rows, 'cockpit')).toMatchObject({ status: 'not-reported' })
    expect(byKey(s.rows, '2')).toMatchObject({ status: 'not-reported' })
    expect(byKey(s.rows, '3')).toMatchObject({ status: 'not-reported', notReported: true })
    // HELLO_ACK 0.0.0 and a node-0 row of 0.0.0 read "version not reported".
    const zero = sheet([], { usb: v('0.0.0'), release: R }, connected('0.0.0'))
    expect(byKey(zero.rows, 'usb')).toMatchObject({ status: 'not-reported', notReported: true })
    expect(byKey(zero.rows, 'cockpit')).toMatchObject({ status: 'not-reported', notReported: true })
  })

  it('while the link is down every row reads not reported, and nothing needs attention', () => {
    const s = sheet(
      [pdu(3, '1.0.0'), pdu(4, '1.0.0', { availability: 'offline' })],
      { usb: v('1.0.0'), release: R },
      { state: 'disconnected' },
      false
    )
    expect(s.rows.every((r) => r.status === 'not-reported' && !r.version)).toBe(true)
    expect(s.attention).toBe(0)
    expect(s.allCurrent).toBe(false)
  })

  it('the Gateway waiting in its update drive (link down, a drive mounted): in-drive, Update (#173)', () => {
    const down = (f: FirmwareInputs) =>
      byKey(sheet([], f, { state: 'reconnecting' }, false).rows, 'usb')
    expect(down({ release: R, usbDrives: 1 })).toEqual({
      key: 'usb',
      side: 'usb',
      name: 'Gateway · USB side',
      status: 'in-drive',
      attention: true,
      action: 'update'
    })
    // Two drives: still waiting; the dialog refuses to guess.
    expect(down({ release: R, usbDrives: 2 }).status).toBe('in-drive')
    // Nothing saved, or no USB image: the state, no Update.
    expect(down({ usbDrives: 1 })).not.toHaveProperty('action')
    expect(down({ release: release('1.0.1', [], false), usbDrives: 1 })).not.toHaveProperty(
      'action'
    )
    // No drive: not reported, as before. The link up: a drive (another board's) changes nothing.
    expect(down({ release: R, usbDrives: 0 }).status).toBe('not-reported')
    const up = sheet([], { usb: v('1.0.1'), release: R, usbDrives: 1 })
    expect(byKey(up.rows, 'usb').status).toBe('ok')
  })

  it('nothing saved: no compare, only the chips that need no release', () => {
    const s = sheet([pdu(3, '1.0.0'), pdu(4, '0.3.0'), board(5, '1.0.0', {}, 0)], {
      usb: v('1.0.0')
    })
    expect(s.target).toBeUndefined()
    expect(byKey(s.rows, 'usb')).toMatchObject({ status: 'no-release', version: '1.0.0' })
    expect(byKey(s.rows, '3')).toMatchObject({ status: 'no-release', attention: false })
    expect(byKey(s.rows, '4').status).toBe('mismatch')
    expect(byKey(s.rows, '5').status).toBe('manual')
    expect(s.attention).toBe(2)
    expect(s.allCurrent).toBe(false)
  })

  it('all current: every row runs the release; new boards on the bus are not rows', () => {
    const s = sheet([pdu(3, '1.0.1'), pdu(4, '1.0.1'), board(20, '0.1.0', { source: 'new' })], {
      usb: v('1.0.1'),
      release: R
    })
    expect(s.rows.map((r) => r.key)).toEqual(['usb', 'cockpit', '3', '4'])
    expect(s.allCurrent).toBe(true)
    expect(s.attention).toBe(0)
  })

  it('a board newer than the release isn’t "every board runs it", and needs no attention', () => {
    const s = sheet([pdu(3, '1.0.1'), pdu(4, '1.0.2')], { usb: v('1.0.1'), release: R })
    expect(byKey(s.rows, '4').status).toBe('newer')
    expect(s.allCurrent).toBe(false)
    expect(s.attention).toBe(0)
  })

  it('the cockpit side with no bootloader: manual update only, never "can update"', () => {
    const s = sheet([], { usb: v('1.0.1'), release: R }, connected('1.0.0', 0))
    expect(byKey(s.rows, 'cockpit')).toMatchObject({
      status: 'manual',
      version: '1.0.0',
      attention: true
    })
    expect(firmwareBanner(s, R)).toMatchObject({ gateway: false, manual: 1 })
    // 0.0.0 with bootloader 00 is not reported, never manual.
    const zero = sheet([], { usb: v('1.0.1'), release: R }, connected('0.0.0', 0))
    expect(byKey(zero.rows, 'cockpit')).toMatchObject({ status: 'not-reported', notReported: true })
  })
})

describe('the Overview firmware banner (#173)', () => {
  const R = release('1.0.1')
  const banner = (nodes: NodeModelEntry[], f: FirmwareInputs, device = connected('1.0.1')) =>
    firmwareBanner(sheet(nodes, f, device), f.release)

  it('names what can update by kind: the Gateway (either side), PDUs, then the manual boards behind', () => {
    expect(
      banner([pdu(3, '1.0.0'), pdu(4, '1.0.0'), board(9, '1.0.0', {}, 0), board(2, '1.0.0')], {
        usb: v('1.0.0'),
        release: R
      })
    ).toEqual({ version: '1.0.1', gateway: true, pdus: 2, boards: 0, manual: 1 })
    // The cockpit side alone is the Gateway too.
    expect(banner([], { usb: v('1.0.1'), release: R }, connected('1.0.0'))).toMatchObject({
      gateway: true,
      pdus: 0
    })
  })

  it('only manual boards behind still raise it; an up-to-date manual board does not', () => {
    expect(banner([board(9, '1.0.0', {}, 0)], { usb: v('1.0.1'), release: R })).toEqual({
      version: '1.0.1',
      gateway: false,
      pdus: 0,
      boards: 0,
      manual: 1
    })
    expect(banner([board(9, '1.0.1', {}, 0)], { usb: v('1.0.1'), release: R })).toBeNull()
  })

  it('none while nothing is behind, custom boards are behind, nothing is saved or the link is down', () => {
    expect(banner([pdu(3, '1.0.1')], { usb: v('1.0.1'), release: R })).toBeNull()
    expect(banner([board(2, '0.9.0'), pdu(6, '1.0.0')], { usb: v('1.0.1'), release: R })).toBeNull()
    expect(banner([pdu(3, '1.0.0')], { usb: v('1.0.0') })).toBeNull()
    const down = sheet(
      [pdu(3, '1.0.0')],
      { usb: v('1.0.0'), release: R },
      { state: 'disconnected' },
      false
    )
    expect(firmwareBanner(down, R)).toBeNull()
  })

  it('the snapshot carries the sheet and the banner from the same rows', () => {
    const { snapshot } = buildCockpitSnapshot({
      model: model([pdu(3, '1.0.0'), pdu(4, '1.0.1')]),
      telemetry: [],
      device: connected('1.0.1'),
      peakW: 0,
      firmware: { usb: v('1.0.1'), release: R },
      now: 0,
      rev: 1
    })
    expect(snapshot.firmware.attention).toBe(1)
    expect(snapshot.overview.firmware).toEqual({
      version: '1.0.1',
      gateway: false,
      pdus: 1,
      boards: 0,
      manual: 0
    })
  })
})

describe('the Gateway’s cockpit side (#187)', () => {
  const R = release('1.0.1')
  const bridge = { uploader: true, bundled: '1.0.1' }

  it('compared with the bundle its USB side carries, not the release', () => {
    const at = (cockpit: string, bundled = '1.0.1') =>
      byKey(
        sheet(
          [],
          { usb: v('1.0.1'), release: release('1.0.2'), bridge: { uploader: true, bundled } },
          connected(cockpit)
        ).rows,
        'cockpit'
      )
    // The USB side is behind 1.0.2: its own update first, which brings a newer bundle.
    expect(at('1.0.0')).toMatchObject({ status: 'update', to: '1.0.2', action: 'usb-first' })
    const usbCurrent = (cockpit: string) =>
      byKey(sheet([], { usb: v('1.0.1'), release: R, bridge }, connected(cockpit)).rows, 'cockpit')
    expect(usbCurrent('1.0.0')).toMatchObject({
      status: 'update',
      to: '1.0.1',
      bundled: true,
      action: 'update'
    })
    expect(usbCurrent('1.0.1')).toMatchObject({ status: 'ok' })
    expect(usbCurrent('1.0.2')).toMatchObject({ status: 'newer', to: '1.0.1' })
  })

  it('no bundle (a dev USB side): the release, as any board', () => {
    const s = sheet(
      [],
      { usb: v('1.0.1'), release: R, bridge: { uploader: true } },
      connected('1.0.0')
    )
    expect(byKey(s.rows, 'cockpit')).toMatchObject({
      status: 'update',
      to: '1.0.1',
      action: 'update'
    })
    expect(byKey(s.rows, 'cockpit').bundled).toBeUndefined()
  })

  it('its update runs: UPDATING on its row, every board PAUSED; none needs attention for it', () => {
    const s = sheet([board(2, '1.0.0'), pdu(3, '1.0.0')], {
      usb: v('1.0.1'),
      release: R,
      bridge,
      cockpitUpdating: { from: '1.0.0', to: '1.0.1' }
    })
    expect(byKey(s.rows, 'cockpit')).toMatchObject({
      status: 'updating',
      version: '1.0.0',
      to: '1.0.1',
      attention: false
    })
    expect(byKey(s.rows, 'cockpit').action).toBeUndefined()
    expect(s.rows.filter((r) => r.nodeId !== undefined).map((r) => r.status)).toEqual([
      'paused',
      'paused'
    ])
    // The Overview banner counts what can update: the cockpit side drops out while it updates.
    expect(firmwareBanner(s, R)).toBeNull()
  })

  it('not responding: its Retry, counted in Needs attention', () => {
    const silent: DeviceStatus = {
      state: 'connected',
      gateway: gatewayStatus(undefined, false, undefined, true)!
    }
    const s = sheet([], { usb: v('1.0.1'), release: R, bridge }, silent)
    expect(byKey(s.rows, 'cockpit')).toMatchObject({
      status: 'not-responding',
      to: '1.0.1',
      action: 'retry',
      attention: true
    })
    expect(s.attention).toBe(1)
  })
})
