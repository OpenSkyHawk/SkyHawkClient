import { describe, expect, it } from 'vitest'
import {
  adoptNode,
  clearReportedHidden,
  differingCount,
  effectiveMapping,
  EMPTY_MAPPING,
  forgetNode,
  MappingError,
  registryDefaults,
  resetMapping,
  sanitizeNodeMapping,
  setHidden,
  setIgnored,
  setNodeMapping,
  type NodeMappingFile
} from './node-mapping'

// Mirrors the bundled NODE_IDS at the #216 pin.
const REGISTRY = {
  0: { name: 'PanelBridge', console: '—' },
  1: { name: 'Center_Armament', console: 'Center' },
  2: { name: 'Right_Navigation', console: 'Right' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' }
}
const defaults = registryDefaults(REGISTRY)

describe('registryDefaults', () => {
  it('leaves out PanelBridge and places each panel on its console PDU', () => {
    expect([...defaults.keys()]).toEqual([1, 2, 3, 4, 5])
    expect(defaults.get(1)).toEqual({
      name: 'Center_Armament',
      console: 'Center',
      kind: 'panel',
      pduId: 5
    })
    expect(defaults.get(2)).toMatchObject({ kind: 'panel', pduId: 4 })
    expect(defaults.get(3)).toEqual({ name: 'PDU_Left', console: 'Left', kind: 'pdu', pduId: null })
  })

  it('leaves the power zone unmapped when a console has no PDU or several', () => {
    const d = registryDefaults({
      1: { name: 'A', console: 'Left' },
      2: { name: 'B', console: 'Right' },
      3: { name: 'PDU_Left_A', console: 'Left' },
      4: { name: 'PDU_Left_B', console: 'Left' }
    })
    expect(d.get(1)?.pduId).toBeNull()
    expect(d.get(2)?.pduId).toBeNull()
  })
})

describe('sanitizeNodeMapping', () => {
  it('returns an empty mapping for garbage', () => {
    for (const raw of [null, 3, 'x', []]) expect(sanitizeNodeMapping(raw)).toEqual(EMPTY_MAPPING)
  })

  it('keeps valid fields and drops bad ones field by field', () => {
    const f = sanitizeNodeMapping({
      version: 9,
      nodes: {
        1: { name: '  Arm  ', console: 7, pduId: 99, hidden: 'yes' },
        2: { pduId: null, hidden: true },
        9: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' },
        64: { name: 'out of range' },
        abc: { name: 'bad key' },
        5: { nonsense: 1 }
      },
      ignored: [12, 12, 0, 70, 'x', 11]
    })
    expect(f).toEqual({
      version: 1,
      nodes: {
        1: { name: 'Arm' },
        2: { pduId: null, hidden: true },
        9: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
      },
      ignored: [11, 12]
    })
  })
})

describe('effectiveMapping / setNodeMapping', () => {
  it('registry defaults apply with no file', () => {
    const m = effectiveMapping(defaults, EMPTY_MAPPING)
    expect(m.get(1)).toEqual({
      nodeId: 1,
      name: 'Center_Armament',
      console: 'Center',
      pduId: 5,
      kind: 'panel',
      source: 'registry',
      differs: false,
      hidden: false
    })
    expect(differingCount(defaults, EMPTY_MAPPING)).toBe(0)
  })

  it('stores only differences, and a value set back to its default is removed', () => {
    let f = setNodeMapping(EMPTY_MAPPING, defaults, 1, { name: 'Armament', pduId: null })
    expect(f.nodes).toEqual({ 1: { name: 'Armament', pduId: null } })
    expect(effectiveMapping(defaults, f).get(1)).toMatchObject({
      name: 'Armament',
      pduId: null,
      differs: true
    })
    expect(differingCount(defaults, f)).toBe(1)
    f = setNodeMapping(f, defaults, 1, { name: 'Center_Armament', pduId: 5 })
    expect(f.nodes).toEqual({})
    expect(differingCount(defaults, f)).toBe(0)
  })

  it('rejects empty text, bad PDU ids and unknown nodes', () => {
    expect(() => setNodeMapping(EMPTY_MAPPING, defaults, 1, { name: '  ' })).toThrow(MappingError)
    expect(() => setNodeMapping(EMPTY_MAPPING, defaults, 1, { pduId: 0 })).toThrow(MappingError)
    expect(() => setNodeMapping(EMPTY_MAPPING, defaults, 30, { name: 'x' })).toThrow(/adopt/)
  })
})

describe('adopt / forget', () => {
  it('stores an adopted node in full and lets it be edited afterwards', () => {
    let f = adoptNode(EMPTY_MAPPING, defaults, 41, {
      name: ' Left_Trim ',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
    expect(f.nodes[41]).toEqual({ name: 'Left_Trim', console: 'Left', pduId: 3, kind: 'panel' })
    expect(effectiveMapping(defaults, f).get(41)).toMatchObject({
      source: 'adopted',
      differs: false
    })
    f = setNodeMapping(f, defaults, 41, { name: 'Trim' })
    expect(f.nodes[41]?.name).toBe('Trim')
    expect(forgetNode(f, 41).nodes[41]).toBeUndefined()
  })

  it('a PDU has no power zone, adopting un-ignores, and registry ids cannot be adopted', () => {
    const ignored = setIgnored(EMPTY_MAPPING, 42, true)
    const f = adoptNode(ignored, defaults, 42, {
      name: 'PDU_Aux',
      console: 'Left',
      pduId: 3,
      kind: 'pdu'
    })
    expect(f.nodes[42]?.pduId).toBeNull()
    expect(f.ignored).toEqual([])
    expect(() =>
      adoptNode(EMPTY_MAPPING, defaults, 1, { name: 'x', console: 'y', pduId: null, kind: 'panel' })
    ).toThrow(/registry/)
  })
})

describe('reset / ignore / hidden', () => {
  const busy: NodeMappingFile = {
    version: 1,
    nodes: {
      1: { name: 'Arm', hidden: true },
      2: { console: 'Left' },
      41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
    },
    ignored: [50]
  }

  it('reset clears registry overrides but keeps adopted nodes, hidden flags and ignores', () => {
    expect(differingCount(defaults, busy)).toBe(2)
    const f = resetMapping(busy, defaults)
    expect(f).toEqual({
      version: 1,
      nodes: { 1: { hidden: true }, 41: busy.nodes[41] },
      ignored: [50]
    })
    expect(differingCount(defaults, f)).toBe(0)
  })

  it('ignored ids drop out of the effective mapping until un-ignored', () => {
    const f = setIgnored(busy, 41, true)
    expect(f.ignored).toEqual([41, 50])
    expect(effectiveMapping(defaults, f).has(41)).toBe(false)
    expect(setIgnored(f, 41, true)).toBe(f)
    expect(effectiveMapping(defaults, setIgnored(f, 41, false)).has(41)).toBe(true)
  })

  it('hidden is set, cleared, and cleared again when the node reports', () => {
    const f = setHidden(EMPTY_MAPPING, 2, true)
    expect(effectiveMapping(defaults, f).get(2)?.hidden).toBe(true)
    expect(setHidden(f, 2, false).nodes).toEqual({})
    expect(clearReportedHidden(f, [1, 2]).nodes).toEqual({})
    expect(clearReportedHidden(f, [1, 3])).toBe(f) // unchanged → same object, no write
  })
})
