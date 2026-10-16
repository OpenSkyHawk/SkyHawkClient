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
  resetPreview,
  sanitizeNodeMapping,
  setHidden,
  setIgnored,
  setNodeMapping,
  type AdoptSpec,
  type MappingPatch,
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

  it('refuses a change or adopt request that is not a plain object (renderer input)', () => {
    for (const bad of [null, undefined, 'x', 7, [], [{ name: 'x' }]]) {
      const patch = bad as unknown as MappingPatch
      const spec = bad as unknown as AdoptSpec
      expect(() => setNodeMapping(EMPTY_MAPPING, defaults, 1, patch)).toThrow(
        new MappingError('Invalid mapping change')
      )
      expect(() => adoptNode(EMPTY_MAPPING, defaults, 41, spec)).toThrow(
        new MappingError('Invalid adopt request')
      )
    }
  })
})

describe('adopt / forget', () => {
  it('requires a name and a console, so an ok always means adopted', () => {
    const spec: AdoptSpec = { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
    for (const [bad, error] of [
      [{ ...spec, name: undefined }, 'Name cannot be empty'],
      [{ ...spec, name: '   ' }, 'Name cannot be empty'],
      [{ ...spec, console: undefined }, 'Console cannot be empty'],
      [{ ...spec, console: ' ' }, 'Console cannot be empty']
    ] as const) {
      expect(() => adoptNode(EMPTY_MAPPING, defaults, 41, bad as unknown as AdoptSpec)).toThrow(
        new MappingError(error)
      )
    }
  })

  it('a panel adopted without a power zone stores an explicit none', () => {
    const spec = { name: 'Trim', console: 'Left', kind: 'panel' } as unknown as AdoptSpec
    const f = adoptNode(EMPTY_MAPPING, defaults, 41, spec)
    expect(f.nodes[41]).toEqual({ name: 'Trim', console: 'Left', pduId: null, kind: 'panel' })
  })

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
    const f = setHidden(EMPTY_MAPPING, defaults, 2, true)
    expect(effectiveMapping(defaults, f).get(2)?.hidden).toBe(true)
    expect(setHidden(f, defaults, 2, false).nodes).toEqual({})
    expect(clearReportedHidden(f, [1, 2]).nodes).toEqual({})
    expect(clearReportedHidden(f, [1, 3])).toBe(f) // unchanged → same object, no write
  })

  it('only registry and adopted nodes can be hidden; un-hiding works for any id', () => {
    expect(() => setHidden(EMPTY_MAPPING, defaults, 41, true)).toThrow(
      new MappingError('Only a registry or adopted node can be hidden — ignore a new node instead')
    )
    const adoptedOnly = adoptNode(EMPTY_MAPPING, defaults, 41, {
      name: 'Trim',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
    expect(
      effectiveMapping(defaults, setHidden(adoptedOnly, defaults, 41, true)).get(41)?.hidden
    ).toBe(true)
    const stray: NodeMappingFile = { version: 1, nodes: { 41: { hidden: true } }, ignored: [] }
    expect(setHidden(stray, defaults, 41, false).nodes).toEqual({})
  })
})

describe('renderer input: on/off values and no-op changes', () => {
  it('ignore and hide accept only a real boolean', () => {
    for (const bad of ['no', 'false', 1, undefined, null]) {
      const on = bad as unknown as boolean
      expect(() => setIgnored(EMPTY_MAPPING, 41, on)).toThrow(
        new MappingError('Invalid on/off value')
      )
      expect(() => setHidden(EMPTY_MAPPING, defaults, 2, on)).toThrow(
        new MappingError('Invalid on/off value')
      )
    }
    expect(setIgnored(EMPTY_MAPPING, 41, true).ignored).toEqual([41])
    expect(setHidden(EMPTY_MAPPING, defaults, 2, true).nodes).toEqual({ 2: { hidden: true } })
  })

  it('forget checks the NODE_ID', () => {
    for (const bad of [NaN, 0, 64, '3']) {
      expect(() => forgetNode(EMPTY_MAPPING, bad as number)).toThrow(MappingError)
    }
  })

  it('a change that changes nothing returns the same object (no write)', () => {
    const f: NodeMappingFile = {
      version: 1,
      nodes: { 1: { name: 'Arm', hidden: true } },
      ignored: [50]
    }
    expect(forgetNode(f, 41)).toBe(f)
    expect(setHidden(f, defaults, 1, true)).toBe(f)
    expect(setHidden(f, defaults, 2, false)).toBe(f)
    expect(setIgnored(f, 50, true)).toBe(f)
    expect(setIgnored(f, 41, false)).toBe(f)
    expect(setNodeMapping(f, defaults, 1, { name: 'Arm' })).toBe(f)
    expect(forgetNode(f, 1).nodes).toEqual({})
  })
})

describe('power zones', () => {
  const trim: AdoptSpec = { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
  const withAux = adoptNode(EMPTY_MAPPING, defaults, 42, {
    name: 'PDU_Aux',
    console: 'Left',
    pduId: null,
    kind: 'pdu'
  })

  it('a PDU has no power zone', () => {
    expect(() => setNodeMapping(EMPTY_MAPPING, defaults, 3, { pduId: 4 })).toThrow(
      new MappingError('A PDU has no power zone')
    )
    expect(() => setNodeMapping(withAux, defaults, 42, { pduId: 3 })).toThrow(
      new MappingError('A PDU has no power zone')
    )
    expect(setNodeMapping(EMPTY_MAPPING, defaults, 3, { pduId: null })).toBe(EMPTY_MAPPING)
  })

  it('a panel is zoned only to a registry or adopted PDU that is not ignored', () => {
    const notPdu = new MappingError('Power zone must be a PDU')
    const set = (f: NodeMappingFile, pduId: number) => () =>
      setNodeMapping(f, defaults, 1, { pduId })
    expect(set(EMPTY_MAPPING, 1)).toThrow(notPdu) // itself
    expect(set(EMPTY_MAPPING, 2)).toThrow(notPdu) // another panel
    expect(set(EMPTY_MAPPING, 42)).toThrow(notPdu) // not adopted
    expect(set(setIgnored(EMPTY_MAPPING, 3, true), 3)).toThrow(notPdu) // ignored PDU
    expect(set(EMPTY_MAPPING, 3)().nodes[1]).toEqual({ pduId: 3 }) // registry PDU
    expect(set(withAux, 42)().nodes[1]).toEqual({ pduId: 42 }) // adopted PDU
    expect(setNodeMapping(EMPTY_MAPPING, defaults, 1, { pduId: null }).nodes[1]).toEqual({
      pduId: null
    })
  })

  it('adopting a panel applies the same rule', () => {
    const notPdu = new MappingError('Power zone must be a PDU')
    expect(() => adoptNode(EMPTY_MAPPING, defaults, 41, { ...trim, pduId: 41 })).toThrow(notPdu)
    expect(() => adoptNode(EMPTY_MAPPING, defaults, 41, { ...trim, pduId: 1 })).toThrow(notPdu)
    expect(() => adoptNode(EMPTY_MAPPING, defaults, 41, { ...trim, pduId: 42 })).toThrow(notPdu)
    expect(adoptNode(withAux, defaults, 41, { ...trim, pduId: 42 }).nodes[41]?.pduId).toBe(42)
    expect(adoptNode(EMPTY_MAPPING, defaults, 41, { ...trim, pduId: 5 }).nodes[41]?.pduId).toBe(5)
  })
})

describe('differingCount matches what Reset changes', () => {
  it('counts an ignored registry node with overrides, since Reset clears it', () => {
    const f: NodeMappingFile = { version: 1, nodes: { 2: { name: 'Nav' } }, ignored: [2] }
    expect(differingCount(defaults, f)).toBe(1)
    const reset = resetMapping(f, defaults)
    expect(reset.nodes).toEqual({})
    expect(differingCount(defaults, reset)).toBe(0)
  })

  it('a reset with nothing to reset returns the same object (no write)', () => {
    const f: NodeMappingFile = {
      version: 1,
      nodes: {
        1: { hidden: true },
        41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
      },
      ignored: [50]
    }
    expect(differingCount(defaults, f)).toBe(0)
    expect(resetMapping(f, defaults)).toBe(f)
  })
})

describe('ignore metadata', () => {
  const at = '2026-10-12T10:00:00.000Z'

  it('is recorded with a new ignore and dropped on un-ignore or adopt', () => {
    const f = setIgnored(EMPTY_MAPPING, 47, true, { at, kind: 'panel' })
    expect(f.ignoredMeta).toEqual({ 47: { at, kind: 'panel' } })
    expect(setIgnored(f, 47, true, { at: '2027-01-01T00:00:00.000Z' })).toBe(f) // first ignore wins
    expect(setIgnored(f, 47, false)).toEqual({ version: 1, nodes: {}, ignored: [] })
    const g = adoptNode(f, defaults, 47, {
      name: 'Trim',
      console: 'Left',
      pduId: null,
      kind: 'panel'
    })
    expect(g.ignored).toEqual([])
    expect(g.ignoredMeta).toBeUndefined()
  })

  it('sanitize keeps entries only for ignored ids with a real date', () => {
    const f = sanitizeNodeMapping({
      version: 1,
      nodes: {},
      ignored: [47, 52],
      ignoredMeta: {
        47: { at, kind: 'gadget' },
        52: { at: 'yesterday' },
        58: { at } // not ignored
      }
    })
    expect(f.ignoredMeta).toEqual({ 47: { at } })
    expect(sanitizeNodeMapping({ ignored: [47], ignoredMeta: 'x' })).not.toHaveProperty(
      'ignoredMeta'
    )
  })
})

describe('reset preview and forgetting adopted nodes', () => {
  const file: NodeMappingFile = {
    version: 1,
    nodes: {
      1: { name: 'Arm', pduId: 3, hidden: true },
      2: { console: 'Left' },
      4: { name: 'PDU_R' }, // a PDU renamed: zones pointing at it show the new name
      41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' },
      55: { hidden: true } // stray flag on an unknown id
    },
    ignored: [2]
  }

  it('lists every changed field, ignored registry nodes included, with zones by name', () => {
    const p = resetPreview(defaults, file)
    expect(p.nodeCount).toBe(differingCount(defaults, file))
    expect(p.rows).toEqual([
      { nodeId: 1, node: 'Center_Armament', field: 'name', from: 'Arm', to: 'Center_Armament' },
      {
        nodeId: 1,
        node: 'Center_Armament',
        field: 'power zone',
        from: 'PDU_Left',
        to: 'PDU_Center'
      },
      { nodeId: 2, node: 'Right_Navigation', field: 'console', from: 'Left', to: 'Right' },
      { nodeId: 4, node: 'PDU_Right', field: 'name', from: 'PDU_R', to: 'PDU_Right' }
    ])
    expect(p.adopted).toEqual([{ nodeId: 41, name: 'Trim', console: 'Left', zone: 'PDU_Left' }])
    expect(resetPreview(defaults, EMPTY_MAPPING)).toEqual({ rows: [], nodeCount: 0, adopted: [] })
  })

  it('forgetAdopted also drops every non-registry entry; the ignore list stays', () => {
    expect(resetMapping(file, defaults, { forgetAdopted: true })).toEqual({
      version: 1,
      nodes: { 1: { hidden: true } },
      ignored: [2]
    })
    const adoptedOnly: NodeMappingFile = { version: 1, nodes: { 41: file.nodes[41]! }, ignored: [] }
    expect(resetMapping(adoptedOnly, defaults)).toBe(adoptedOnly) // nothing to reset
    expect(resetMapping(adoptedOnly, defaults, { forgetAdopted: true }).nodes).toEqual({})
  })

  it('refuses a malformed reset request', () => {
    for (const bad of [null, 'yes', [], { forgetAdopted: 'yes' }]) {
      expect(() => resetMapping(file, defaults, bad as never)).toThrow(
        new MappingError('Invalid reset request')
      )
    }
  })
})
