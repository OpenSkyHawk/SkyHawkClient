// #171: each board's firmware release and a major mismatch with the Gateway, from the status rows
// (v4) to the views, the plan, the ring, Attention and the board's sheet.
import { describe, expect, it } from 'vitest'
import { FIRMWARE_RELEASE } from '@shared/firmware'
import type { GatewayFirmware } from '@shared/gateway'
import type { NodeModelEntry } from '@shared/nodes'
import { modelNode as node, nodeModel as model, nodeStatus } from '../../../test-fixtures/nodes'
import {
  SUPPORTED_FIRMWARE_MAJOR,
  gatewayFirmware,
  majorMismatch,
  newerThanClient,
  noBootloader,
  reportedVersion,
  versionNotReported
} from '../../gateway/firmware'
import { attentionItems } from './attention'
import { healthBand } from './band'
import { boardFirmwareRows, nodeFaultBoxes, nodeStatusRows } from './panels'
import { nodeViews } from './views'

/** A board in your cockpit, online, reporting firmware `fw` ([0, 0, 0] = not reported). */
const board = (nodeId: number, fw: [number, number, number], over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, {
    status: nodeStatus(nodeId, { nodeKind: 1, fwMajor: fw[0], fwMinor: fw[1], fwPatch: fw[2] }),
    ...over
  })

const gw = (major: number, minor = 0, patch = 0): GatewayFirmware =>
  gatewayFirmware(
    nodeStatus(0, { nodeKind: 3, fwMajor: major, fwMinor: minor, fwPatch: patch, bootloader: 1 })
  )

describe('firmware releases (gateway/firmware.ts)', () => {
  it('a row reports x.y.z; 0.0.0 is "not reported"', () => {
    expect(reportedVersion(nodeStatus(1, { fwMajor: 1, fwMinor: 2, fwPatch: 3 }))).toEqual({
      major: 1,
      minor: 2,
      patch: 3
    })
    expect(reportedVersion(nodeStatus(1))).toBeNull()
    expect(reportedVersion(undefined)).toBeNull()
    // 0.0.0 in a row is "not reported"; no row is no data.
    expect(versionNotReported(nodeStatus(1))).toBe(true)
    expect(versionNotReported(undefined)).toBe(false)
    expect(versionNotReported(nodeStatus(1, { fwMajor: 1, fwMinor: 2, fwPatch: 3 }))).toBe(false)
  })

  it('no bootloader: 00 on a row that reports a version; 00 on 0.0.0 is "not reported" (#175)', () => {
    expect(noBootloader(nodeStatus(1, { fwMajor: 0, fwMinor: 3, fwPatch: 0, bootloader: 0 }))).toBe(
      true
    )
    expect(noBootloader(nodeStatus(1, { fwMajor: 0, fwMinor: 3, fwPatch: 0, bootloader: 1 }))).toBe(
      false
    )
    expect(noBootloader(nodeStatus(1, { bootloader: 0 }))).toBe(false)
    expect(noBootloader(undefined)).toBe(false)
    expect(
      gatewayFirmware(nodeStatus(0, { nodeKind: 3, fwMajor: 0, fwMinor: 3, bootloader: 0 }))
        .noBootloader
    ).toBe(true)
  })

  it('the Gateway is "too new" only past the supported major', () => {
    expect(SUPPORTED_FIRMWARE_MAJOR).toBe(1)
    expect(gw(0, 3, 0)).toEqual({
      version: { major: 0, minor: 3, patch: 0 },
      tooNew: false,
      supportedMajor: 1
    })
    expect(gw(1, 9, 9)).toEqual({
      version: { major: 1, minor: 9, patch: 9 },
      tooNew: false,
      supportedMajor: 1
    })
    expect(gw(2).tooNew).toBe(true)
    expect(gw(0, 0, 0)).toEqual({ version: null, tooNew: false, supportedMajor: 1 })
  })

  it('the synced firmware is never on a newer major than the client supports', () => {
    // A re-sync to firmware on a newer major fails here until the constant is raised on purpose.
    expect(FIRMWARE_RELEASE.major).toBeLessThanOrEqual(SUPPORTED_FIRMWARE_MAJOR)
  })

  it('newerThanClient: only a major past the supported one', () => {
    expect(newerThanClient({ major: 0, minor: 3, patch: 0 })).toBe(false)
    expect(newerThanClient({ major: 1, minor: 9, patch: 9 })).toBe(false)
    expect(newerThanClient({ major: 2, minor: 0, patch: 0 })).toBe(true)
  })

  it('a mismatch is a different major, never while either side is 0.0.0', () => {
    expect(majorMismatch({ major: 0, minor: 2, patch: 0 }, gw(1))).toEqual({ board: 0, gateway: 1 })
    expect(majorMismatch({ major: 1, minor: 4, patch: 2 }, gw(1, 0, 1))).toBeUndefined()
    expect(majorMismatch(null, gw(1))).toBeUndefined()
    expect(majorMismatch({ major: 0, minor: 2, patch: 0 }, gw(0, 0, 0))).toBeUndefined()
    expect(majorMismatch({ major: 0, minor: 2, patch: 0 }, undefined)).toBeUndefined()
  })
})

describe('a board on another major than the Gateway (#171)', () => {
  const m = model([
    board(1, [1, 0, 1]), // matches
    board(2, [0, 2, 0]), // mismatch, otherwise healthy
    board(3, [0, 2, 0], {
      status: nodeStatus(3, {
        nodeKind: 1,
        fwMajor: 0,
        fwMinor: 2,
        degraded: true,
        faultId: 1,
        faultLabel: 'I2C peripheral',
        faultAbbr: 'I2C'
      })
    }), // mismatch and a fault of its own
    board(4, [0, 0, 0]) // not reported: never a mismatch
  ])
  const views = nodeViews(m, [], gw(1))
  const view = (id: number) => views.find((v) => v.entry.nodeId === id)!
  /** A board in your cockpit not seen since the bridge booted: no row, so no data. */
  const noRow = nodeViews(
    model([node(5, { availability: 'offline', notSeen: true, status: undefined })]),
    [],
    gw(1)
  )[0]!

  it('each view carries its release, and the mismatch when there is one', () => {
    expect(view(1).firmware).toEqual({ version: { major: 1, minor: 0, patch: 1 } })
    expect(view(2).firmware).toEqual({
      version: { major: 0, minor: 2, patch: 0 },
      mismatch: { board: 0, gateway: 1 }
    })
    expect(view(4).firmware).toEqual({ version: null, notReported: true })
    expect(noRow.firmware).toEqual({ version: null })
  })

  it('a gold ! on the tile and a warning in the ring; a board fault keeps its own flag too', () => {
    expect(view(1).health).toEqual({ state: 'on' })
    expect(view(2).health).toEqual({ state: 'warn', flag: 'FW MISMATCH' })
    expect(view(3).health).toEqual({ state: 'warn', flag: 'I2C · FW MISMATCH' })
    expect(view(4).health).toEqual({ state: 'on' })
    // The ring counts it as a warning; the tile's tooltip reads its health flag.
    expect(healthBand(views).warn).toBe(2)
  })

  it('Attention: its own item, ahead of the faults; the fault item keeps only the board’s flags', () => {
    const items = attentionItems(views, [])
    expect(items.map((i) => [i.key, i.flag])).toEqual([
      ['f-2', 'runs firmware 0.x, Gateway runs 1.x — reflash it'],
      ['f-3', 'runs firmware 0.x, Gateway runs 1.x — reflash it'],
      ['n-3', 'I2C']
    ])
  })

  it('the sheet: a Firmware mismatch box first; its Status row stays what the board says', () => {
    expect(nodeFaultBoxes(view(2))).toEqual([
      {
        tone: 'warn',
        title: 'Firmware mismatch',
        text: 'it runs firmware 0.x, the Gateway runs 1.x — reflash it. Boards on different major versions don’t work together on the bus.'
      }
    ])
    expect(nodeFaultBoxes(view(3)).map((b) => b.title)).toEqual([
      'Firmware mismatch',
      'I2C peripheral'
    ])
    expect(nodeStatusRows(view(2))[0]).toEqual({ k: 'Status', v: 'healthy' })
  })

  it('the sheet’s Firmware section: the release, "version not reported", or a dash with no row', () => {
    expect(boardFirmwareRows(view(1))).toEqual({ installed: '1.0.1' })
    expect(boardFirmwareRows(view(4))).toEqual({
      installed: 'version not reported',
      hint: 'This board hasn’t reported its firmware version yet.'
    })
    expect(boardFirmwareRows(noRow)).toEqual({ installed: '—' })
  })

  it('no Gateway release (not reported, or no row yet): nothing to compare, no mismatch', () => {
    for (const g of [gw(0, 0, 0), undefined]) {
      const vs = nodeViews(m, [], g)
      expect(vs.filter((v) => v.firmware.mismatch)).toEqual([])
      expect(attentionItems(vs, []).filter((i) => i.key.startsWith('f-'))).toEqual([])
    }
  })

  it('an offline board keeps its last row: 0.0.0 still reads "version not reported", never a mismatch', () => {
    const v = nodeViews(model([board(6, [0, 0, 0], { availability: 'offline' })]), [], gw(1))[0]!
    expect(v.firmware).toEqual({ version: null, notReported: true })
    expect(boardFirmwareRows(v)).toEqual({
      installed: 'version not reported',
      hint: 'This board hasn’t reported its firmware version yet.'
    })
  })

  it('an offline board shows no mismatch item: offline says it all', () => {
    const vs = nodeViews(model([board(2, [0, 2, 0], { availability: 'offline' })]), [], gw(1))
    expect(attentionItems(vs, []).map((i) => i.key)).toEqual(['n-2'])
    expect(vs[0]!.health.state).toBe('off')
  })
})
