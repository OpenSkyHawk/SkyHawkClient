import { describe, expect, it } from 'vitest'
import type { NodeModel, NodeModelEntry } from '@shared/node-rules'
import type { NodeStatus } from '@shared/nodes'
import { PDU_FLAG, RAIL_FLAG, TELEM_PAGE, type NodeTelemSnapshot } from '@shared/node-telem'
import { nodeViews } from './cockpit'
import {
  CONSOLE_OPTIONS,
  consoleLabel,
  firstPduOn,
  mappingPatch,
  nodeActions,
  nodeFaultBoxes,
  nodeStatusRows,
  pduBoardRows,
  pduFaultBoxes,
  pduRailRows,
  powerZoneOptions
} from './cockpit-panels'

const status = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus => ({
  nodeId,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 3725,
  rxCount: 12345,
  tec: 8,
  rec: 1,
  dieTempC: 33,
  overheat: false,
  degraded: false,
  faultId: 0,
  ...over
})

const node = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry => ({
  nodeId,
  name: `Node_${nodeId}`,
  console: 'Center',
  pduId: null,
  kind: 'panel',
  source: 'registry',
  availability: 'online',
  status: status(nodeId),
  differs: false,
  ...over
})

const pdu = (nodeId: number, console: string, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, {
    name: `PDU_${console}`,
    console,
    kind: 'pdu',
    readings: 'live',
    everHadReadings: true,
    ...over
  })

const telem = (
  nodeId: number,
  o: { flags12?: number; flags5?: number; status?: number; ntc?: number | null } = {}
): NodeTelemSnapshot => ({
  nodeId,
  isPdu: true,
  rail12V: {
    kind: 'rail',
    page: TELEM_PAGE.PDU_RAIL_12V,
    flags: o.flags12 ?? 0,
    vAvgMv: 12_060,
    vMinMv: 12_010,
    iAvgMa: 940,
    ageMs: 500,
    stale: false
  },
  rail5V: {
    kind: 'rail',
    page: TELEM_PAGE.PDU_RAIL_5V,
    flags: o.flags5 ?? 0,
    vAvgMv: 5030,
    vMinMv: 5000,
    iAvgMa: -12,
    ageMs: 500,
    stale: false
  },
  status: {
    kind: 'status',
    page: TELEM_PAGE.PDU_STATUS,
    flags: o.status ?? 0,
    ntcTempC: o.ntc === undefined ? 31.4 : o.ntc,
    i12PeakMa: 1400,
    i5PeakMa: 980,
    ageMs: 500,
    stale: false
  },
  other: [],
  live: true
})

const model = (nodes: NodeModelEntry[]): NodeModel => ({
  nodes,
  outages: [],
  differingCount: 0,
  ignored: [],
  ignoredNodes: [],
  hidden: [],
  hiddenNodes: [],
  rosterComplete: true
})

const view = (e: NodeModelEntry, t: NodeTelemSnapshot[] = []) => nodeViews(model([e]), t)[0]!

describe('nodeActions', () => {
  it('registry: reset, plus hide while offline', () => {
    expect(nodeActions(node(1))).toEqual(['reset'])
    expect(nodeActions(node(1, { availability: 'offline' }))).toEqual(['reset', 'hide'])
  })

  it('adopted: forget instead of reset, plus hide while offline', () => {
    expect(nodeActions(node(9, { source: 'adopted' }))).toEqual(['forget'])
    expect(nodeActions(node(9, { source: 'adopted', availability: 'offline' }))).toEqual([
      'forget',
      'hide'
    ])
  })

  it('new: ignore only', () => {
    expect(nodeActions(node(41, { source: 'new', console: null }))).toEqual(['ignore'])
  })

  it('never offers hide before the roster says offline', () => {
    expect(nodeActions(node(1, { availability: 'unknown', status: undefined }))).toEqual(['reset'])
  })
})

describe('nodeFaultBoxes', () => {
  const titles = (e: NodeModelEntry) => nodeFaultBoxes(view(e)).map((b) => b.title)

  it('nothing to say for a healthy node', () => {
    expect(nodeFaultBoxes(view(node(1)))).toEqual([])
  })

  it('offline is a single error box', () => {
    expect(nodeFaultBoxes(view(node(1, { availability: 'offline' })))).toEqual([
      {
        tone: 'err',
        title: 'Offline',
        text: 'missing from the PanelBridge roster — no heartbeat within its timeout.'
      }
    ])
  })

  it('degraded shows the fault table’s label and description', () => {
    const e = node(2, {
      status: status(2, {
        degraded: true,
        faultId: 1,
        faultLabel: 'I2C peripheral',
        faultDesc: 'an I2C device tripped its breaker.'
      })
    })
    expect(nodeFaultBoxes(view(e))).toEqual([
      { tone: 'warn', title: 'I2C peripheral', text: 'an I2C device tripped its breaker.' }
    ])
  })

  it('an unknown fault code still gets a box, named by its number', () => {
    expect(titles(node(2, { status: status(2, { degraded: true, faultId: 77 }) }))).toEqual([
      'Fault 77'
    ])
  })

  it('names bus-off, error-passive and overheat on their own', () => {
    expect(titles(node(2, { status: status(2, { boff: true }) }))).toEqual(['Bus-off'])
    expect(titles(node(3, { status: status(3, { epvf: true }) }))).toEqual(['Error-passive'])
    expect(titles(node(3, { status: status(3, { overheat: true }) }))).toEqual(['Overheat'])
  })

  // Review of #85: only the first raised fault showed; a second one vanished from the panel.
  it('every raised fault gets its own box, in the order the tile names them', () => {
    const e = node(2, {
      status: status(2, {
        boff: true,
        degraded: true,
        faultId: 3,
        faultLabel: 'I2C bus',
        overheat: true,
        epvf: true
      })
    })
    expect(nodeFaultBoxes(view(e)).map((b) => [b.tone, b.title])).toEqual([
      ['err', 'Bus-off'],
      ['warn', 'I2C bus'],
      ['warn', 'Overheat'],
      ['warn', 'Error-passive']
    ])
  })

  it('degraded and overheat both show', () => {
    const e = node(2, { status: status(2, { degraded: true, faultId: 3, overheat: true }) })
    expect(titles(e)).toEqual(['Fault 3', 'Overheat'])
  })

  it('explains a node with no status yet', () => {
    expect(titles(node(1, { availability: 'unknown', status: undefined }))).toEqual([
      'No status yet'
    ])
  })
})

describe('pduFaultBoxes', () => {
  it('offline stands alone, and mentions the fuse only when its nodes dropped with it', () => {
    const v = view(pdu(6, 'Center', { availability: 'offline' }))
    expect(pduFaultBoxes(v, false)).toEqual([
      { tone: 'err', title: 'Offline', text: 'no status or readings from this PDU.' }
    ])
    expect(pduFaultBoxes(v, true)[0]!.text).toMatch(
      /a blown 5 V fuse at the PDU looks like this\.$/
    )
  })

  it('no readings: the firmware hint only when it never had any', () => {
    const had = view(pdu(3, 'Left', { readings: 'none', everHadReadings: true }))
    const never = view(pdu(3, 'Left', { readings: 'none', everHadReadings: false }))
    expect(
      pduFaultBoxes(had, false)
        .map((b) => b.text)
        .join()
    ).not.toMatch(/firmware/)
    expect(pduFaultBoxes(never, false)[0]!.text).toMatch(/PanelBridge firmware may be too old/)
  })

  it('a raised flag names it and says what it means, as NodeStatus.h does', () => {
    const v = view(pdu(4, 'Right'), [
      telem(4, { flags5: RAIL_FLAG.UNDER_V, status: PDU_FLAG.TEMP_WARN })
    ])
    expect(pduFaultBoxes(v, false)).toEqual([
      {
        tone: 'warn',
        title: '5V UNDER-V · TEMP WARN',
        text: 'the 5 V rail is below its under-voltage threshold; board temperature at the warning threshold. Raised by the board.'
      }
    ])
  })

  it('calibration state alone is not a fault', () => {
    const v = view(pdu(4, 'Right'), [telem(4, { status: PDU_FLAG.UNCAL_VDDA })])
    expect(pduFaultBoxes(v, false)).toEqual([])
  })

  // Review of #85: the PDU's own node fault was hidden behind "no readings" or a raised flag.
  it('bus-off shows even when the PDU has no readings', () => {
    const v = view(pdu(3, 'Left', { readings: 'none', status: status(3, { boff: true }) }))
    expect(pduFaultBoxes(v, false).map((b) => b.title)).toEqual(['Bus-off', 'No readings received'])
  })

  it('a degraded PDU keeps its fault label next to "no readings"', () => {
    const v = view(
      pdu(3, 'Left', { readings: 'none', status: status(3, { degraded: true, faultId: 7 }) })
    )
    expect(pduFaultBoxes(v, false).map((b) => b.title)).toEqual(['Fault 7', 'No readings received'])
  })

  it('a PDU with two node faults shows both before its flags', () => {
    const e = pdu(4, 'Right', { status: status(4, { degraded: true, faultId: 8, epvf: true }) })
    const v = view(e, [telem(4, { flags5: RAIL_FLAG.UNDER_V })])
    expect(pduFaultBoxes(v, false).map((b) => b.title)).toEqual([
      'Fault 8',
      'Error-passive',
      '5V UNDER-V'
    ])
  })

  it('a degraded PDU keeps its fault label next to a raised rail flag', () => {
    const e = pdu(4, 'Right', {
      status: status(4, { degraded: true, faultId: 8, faultLabel: 'Sensor fault' })
    })
    const v = view(e, [telem(4, { flags12: RAIL_FLAG.SENSOR_FAULT })])
    expect(pduFaultBoxes(v, false).map((b) => [b.tone, b.title])).toEqual([
      ['warn', 'Sensor fault'],
      ['warn', '12V SENSOR FAULT']
    ])
  })
})

describe('nodeStatusRows', () => {
  it('reports what the node said', () => {
    expect(nodeStatusRows(view(node(1)))).toEqual([
      { k: 'Status', v: 'healthy' },
      { k: 'Uptime', v: '01:02:05' },
      { k: 'CAN frames rx', v: '12,345' },
      { k: 'CAN TEC / REC', v: '8 / 1' },
      { k: 'CAN state', v: 'error-active' },
      { k: 'MCU temp', v: '33 °C' }
    ])
  })

  it('offline keeps only the last rx count', () => {
    const rows = nodeStatusRows(view(node(1, { availability: 'offline' })))
    expect(rows.map((r) => r.v)).toEqual(['offline', '—', '12,345 (last seen)', '—', '—', '—'])
  })

  it('names bus-off, error-passive and degraded', () => {
    const v = (o: Partial<NodeStatus>) => nodeStatusRows(view(node(1, { status: status(1, o) })))
    expect(v({ boff: true })[0]!.v).toBe('bus-off')
    expect(v({ boff: true })[4]!.v).toBe('bus-off')
    expect(v({ epvf: true })[4]!.v).toBe('error-passive')
    expect(v({ degraded: true })[0]!.v).toBe('degraded')
  })

  it('no status yet: every value is a dash', () => {
    const rows = nodeStatusRows(view(node(1, { availability: 'unknown', status: undefined })))
    expect(rows.map((r) => r.v)).toEqual(['no status yet', '—', '—', '—', '—', '—'])
  })
})

describe('pduRailRows', () => {
  it('avg / min / A / peak A per rail, and W computed here', () => {
    const [r12, r5] = pduRailRows(view(pdu(3, 'Left'), [telem(3, { flags12: RAIL_FLAG.OVER_V })]))
    expect(r12).toEqual({
      rail: '12 V',
      avg: '12.06',
      min: '12.01',
      amps: '0.94',
      peak: '1.40',
      watts: '11.3',
      flagged: true
    })
    // a small negative offset reads as 0 A
    expect(r5).toMatchObject({ amps: '0.00', peak: '0.98', watts: '0.0', flagged: false })
  })

  it('dashes when the PDU is offline or has no readings', () => {
    for (const e of [
      pdu(3, 'Left', { availability: 'offline' }),
      pdu(3, 'Left', { readings: 'none' })
    ]) {
      const rows = pduRailRows(view(e, [telem(3)]))
      expect(rows.every((r) => r.avg === '—' && r.peak === '—' && r.watts === '')).toBe(true)
    }
  })
})

describe('pduBoardRows', () => {
  it('NTC, MCU temp and calibration state', () => {
    const v = view(pdu(4, 'Right'), [telem(4, { status: PDU_FLAG.UNCAL_ZERO })])
    expect(pduBoardRows(v)).toEqual([
      { k: 'Connector temp (NTC)', v: '31.4 °C' },
      { k: 'MCU temp', v: '33 °C' },
      { k: 'VDDA calibration', v: 'done' },
      { k: 'Zero calibration', v: 'not done' }
    ])
  })

  it('says why the NTC has no value', () => {
    const fault = view(pdu(4, 'Right'), [telem(4, { status: PDU_FLAG.NTC_FAULT })])
    const missing = view(pdu(4, 'Right'), [telem(4, { ntc: null })])
    expect(pduBoardRows(fault)[0]!.v).toBe('fault — NTC open or shorted')
    expect(pduBoardRows(missing)[0]!.v).toBe('unavailable')
  })

  it('VDDA not calibrated says what that means for the readings', () => {
    const v = view(pdu(4, 'Right'), [telem(4, { status: PDU_FLAG.UNCAL_VDDA })])
    expect(pduBoardRows(v)[2]!.v).toBe('not done — readings assume a nominal 3.3 V')
  })
})

describe('placement', () => {
  const views = nodeViews(
    model([
      pdu(3, 'Left'),
      pdu(5, 'Center'),
      pdu(6, 'Center'),
      pdu(42, 'Left', { source: 'new', console: null }),
      node(1, { pduId: 5 })
    ]),
    []
  )

  it('consoles use the NODE_IDS names', () => {
    expect(CONSOLE_OPTIONS.map((c) => c.value)).toEqual(['Left', 'Center', 'Right'])
    expect(consoleLabel('Center')).toBe('Instrument panel')
    expect(consoleLabel('Aft')).toBe('Aft')
  })

  it('power zones are the placed PDUs on the chosen console', () => {
    expect(powerZoneOptions(views, 'Center', 5)).toEqual([
      { value: 5, label: 'PDU_Center' },
      { value: 6, label: 'PDU_Center' }
    ])
    expect(powerZoneOptions(views, 'Right', null)).toEqual([])
  })

  it('keeps a stored zone on another console listed, marked, until it is changed', () => {
    expect(powerZoneOptions(views, 'Center', 3)).toEqual([
      { value: 5, label: 'PDU_Center' },
      { value: 6, label: 'PDU_Center' },
      { value: 3, label: 'PDU_Left (other console)' }
    ])
  })

  it('a console picks its first PDU, none when it has none', () => {
    expect(firstPduOn(views, 'Center')).toBe(5)
    expect(firstPduOn(views, 'Right')).toBeNull()
  })

  it('Save sends only what changed', () => {
    const e = node(1, { name: 'Center_Armament', console: 'Center', pduId: 5 })
    expect(mappingPatch(e, { name: 'Center_Armament ', console: 'Center', pduId: 5 })).toEqual({})
    expect(mappingPatch(e, { name: 'Arm', console: 'Left', pduId: 3 })).toEqual({
      name: 'Arm',
      console: 'Left',
      pduId: 3
    })
    expect(mappingPatch(e, { name: 'Center_Armament', console: 'Center', pduId: null })).toEqual({
      pduId: null
    })
  })

  it('a PDU only renames', () => {
    const p = pdu(3, 'Left')
    expect(mappingPatch(p, { name: 'PDU_Port', console: 'Right', pduId: 4 })).toEqual({
      name: 'PDU_Port'
    })
  })
})
