import { describe, expect, it } from 'vitest'
import {
  adoptNode,
  checkImportedMapping,
  clearReportedHidden,
  differingCount,
  effectiveMapping,
  EMPTY_MAPPING,
  forgetNode,
  importMapping,
  MappingError,
  markSeen,
  recordKinds,
  resetMapping,
  resetNode,
  resetPreview,
  sanitizeNodeMapping,
  setHidden,
  setNodeMapping,
  type KindOf
} from './mapping-rules'
import { registryDefaults } from './registry'
import { forgettable } from './membership'
import { boardIdentity } from './node-kind'
import { NODE_KINDS } from '@shared/firmware'
import type {
  AdoptSpec,
  MappingPatch,
  NodeDefaults,
  NodeKind,
  NodeMappingFile
} from '@shared/nodes'

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

/**
 * main's KindOf (NodeHub.kindOf, node-kind.ts boardIdentity): what a board reports now (`said`),
 * else the kind stored for a board in your cockpit. kindOf is required (S7), so every call says it.
 */
const kinds =
  (f: NodeMappingFile, d: Map<number, NodeDefaults>, said: Record<number, NodeKind> = {}): KindOf =>
  (id) =>
    boardIdentity(effectiveMapping(d, f), id, {
      reported: said[id] === undefined ? undefined : REPORTS[said[id]]
    })
const REPORTS = { panel: NODE_KINDS.PANEL_GROUP, pdu: NODE_KINDS.PDU } as const
/** The board being adopted reports what the request says it is; the rest as stored. */
const reports = (f: NodeMappingFile, d: Map<number, NodeDefaults>, id: number, spec: AdoptSpec) =>
  kinds(f, d, { [id]: spec.kind })
/** Every registry board added to your cockpit (#93): what editing, hiding and zoning need. */
const ADDED: NodeMappingFile = {
  version: 4,
  nodes: {
    1: { added: true },
    2: { added: true },
    3: { added: true },
    4: { added: true },
    5: { added: true }
  }
}
/** The entries without the `added` marker, to compare only what a change stored. */
const stored = (f: NodeMappingFile) =>
  Object.fromEntries(
    Object.entries(f.nodes)
      .map(([k, { added: _a, ...o }]) => [k, o])
      .filter(([, o]) => Object.keys(o).length)
  )

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
      version: 1,
      nodes: {
        1: { name: '  Arm  ', console: 7, pduId: 99, hidden: 'yes', lastSeen: 'yesterday' },
        2: { pduId: null, hidden: true, lastSeen: '2026-10-14T21:14:00.000Z' },
        9: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' },
        64: { name: 'out of range' },
        abc: { name: 'bad key' },
        5: { nonsense: 1 }
      },
      ignored: [12, 12, 0, 70, 'x', 11]
    })
    expect(f).toEqual({
      version: 4,
      nodes: {
        1: { name: 'Arm', added: true }, // placed before the marker existed: still in your cockpit
        2: { pduId: null, hidden: true, lastSeen: '2026-10-14T21:14:00.000Z', added: true },
        // adopted: v4's one marker covers adopted boards too (S1)
        9: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel', added: true }
      }
    })
    expect(sanitizeNodeMapping({ nodes: { 3: { added: true } } }).nodes).toEqual({
      3: { added: true }
    })
  })

  it('derives "added" only for a file from before v3; a v3 file is read as written', () => {
    expect(sanitizeNodeMapping({ version: 3, nodes: { 2: { name: 'Nav' } } }).nodes[2]).toEqual({
      name: 'Nav'
    })
    for (const version of [1, 2, undefined]) {
      expect(sanitizeNodeMapping({ version, nodes: { 2: { name: 'Nav' } } }).nodes[2]).toEqual({
        name: 'Nav',
        added: true
      })
    }
  })

  it('reads a v1 file as v2 and discards its ignore list (#93: Ignore never shipped)', () => {
    const f = sanitizeNodeMapping({
      version: 1,
      nodes: { 2: { name: 'Nav' } },
      ignored: [2, 47],
      ignoredMeta: { 47: { at: '2026-10-12T10:00:00.000Z' } }
    })
    expect(f).toEqual({ version: 4, nodes: { 2: { name: 'Nav', added: true } } })
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
      hidden: false,
      known: false
    })
    expect(differingCount(defaults, EMPTY_MAPPING)).toBe(0)
  })

  it('known = in your cockpit: a registry board you added; an adopted one always', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { added: true, lastSeen: '2026-10-14T21:14:00.000Z' },
        2: { pduId: null }, // an override alone (in memory) does not add it
        41: { added: true, name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
      }
    }
    const m = effectiveMapping(defaults, f)
    expect([1, 2, 3, 41].map((id) => m.get(id)?.known)).toEqual([true, false, false, true])
    expect(m.get(1)).toMatchObject({ lastSeen: '2026-10-14T21:14:00.000Z', differs: false })
  })

  it('stores only differences, and a value set back to its default is removed', () => {
    let f = setNodeMapping(
      ADDED,
      defaults,
      1,
      { name: 'Armament', pduId: null },
      kinds(ADDED, defaults)
    )
    expect(stored(f)).toEqual({ 1: { name: 'Armament', pduId: null } })
    expect(effectiveMapping(defaults, f).get(1)).toMatchObject({
      name: 'Armament',
      pduId: null,
      differs: true
    })
    expect(differingCount(defaults, f)).toBe(1)
    f = setNodeMapping(f, defaults, 1, { name: 'Center_Armament', pduId: 5 }, kinds(f, defaults))
    expect(stored(f)).toEqual({})
    expect(differingCount(defaults, f)).toBe(0)
  })

  it('rejects empty text, bad PDU ids and unknown nodes', () => {
    expect(() =>
      setNodeMapping(ADDED, defaults, 1, { name: '  ' }, kinds(ADDED, defaults))
    ).toThrow(MappingError)
    expect(() => setNodeMapping(ADDED, defaults, 1, { pduId: 0 }, kinds(ADDED, defaults))).toThrow(
      MappingError
    )
    expect(() =>
      setNodeMapping(ADDED, defaults, 30, { name: 'x' }, kinds(ADDED, defaults))
    ).toThrow(/add it first/)
    expect(() =>
      setNodeMapping(EMPTY_MAPPING, defaults, 1, { name: 'x' }, kinds(EMPTY_MAPPING, defaults))
    ).toThrow(/add it first/)
  })

  it('refuses a change or adopt request that is not a plain object (renderer input)', () => {
    for (const bad of [null, undefined, 'x', 7, [], [{ name: 'x' }]]) {
      const patch = bad as unknown as MappingPatch
      const spec = bad as unknown as AdoptSpec
      expect(() => setNodeMapping(ADDED, defaults, 1, patch, kinds(ADDED, defaults))).toThrow(
        new MappingError('Invalid mapping change')
      )
      expect(() =>
        adoptNode(EMPTY_MAPPING, defaults, 41, spec, kinds(EMPTY_MAPPING, defaults))
      ).toThrow(new MappingError('Invalid adopt request'))
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
      expect(() =>
        adoptNode(
          EMPTY_MAPPING,
          defaults,
          41,
          bad as unknown as AdoptSpec,
          kinds(EMPTY_MAPPING, defaults)
        )
      ).toThrow(new MappingError(error))
    }
  })

  it('a panel adopted without a power zone stores an explicit none', () => {
    const spec = { name: 'Trim', console: 'Left', kind: 'panel' } as unknown as AdoptSpec
    const f = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      spec,
      reports(EMPTY_MAPPING, defaults, 41, spec)
    )
    expect(f.nodes[41]).toEqual({
      added: true,
      name: 'Trim',
      console: 'Left',
      pduId: null,
      kind: 'panel'
    })
  })

  it('stores an adopted node in full and lets it be edited afterwards', () => {
    let f = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      {
        name: ' Left_Trim ',
        console: 'Left',
        pduId: 3,
        kind: 'panel'
      },
      kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
    )
    expect(f.nodes[41]).toEqual({
      added: true,
      name: 'Left_Trim',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
    expect(effectiveMapping(defaults, f).get(41)).toMatchObject({
      source: 'adopted',
      differs: false
    })
    f = setNodeMapping(f, defaults, 41, { name: 'Trim' }, kinds(f, defaults))
    expect(f.nodes[41]?.name).toBe('Trim')
    expect(forgetNode(f, defaults, 41, kinds(f, defaults)).nodes[41]).toBeUndefined()
  })

  it('an adopted PDU has no power zone', () => {
    const f = adoptNode(
      EMPTY_MAPPING,
      defaults,
      42,
      {
        name: 'PDU_Aux',
        console: 'Left',
        pduId: 3,
        kind: 'pdu'
      },
      kinds(EMPTY_MAPPING, defaults, { 42: 'pdu' })
    )
    expect(f.nodes[42]?.pduId).toBeNull()
  })

  it('adding a registry board (#93): its defaults stay defaults, only changes are stored', () => {
    // With kindOf required (S7) the kind the board reported is always stored with the marker (S1).
    const spec = { name: 'Center_Armament', console: 'Center', pduId: 5, kind: 'panel' } as const
    const f = adoptNode(EMPTY_MAPPING, defaults, 1, spec, reports(EMPTY_MAPPING, defaults, 1, spec))
    expect(f.nodes[1]).toEqual({ added: true, kind: 'panel' })
    expect(effectiveMapping(defaults, f).get(1)).toMatchObject({ known: true, source: 'registry' })
    expect(
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        1,
        { ...spec, name: 'Arm', pduId: null },
        reports(EMPTY_MAPPING, defaults, 1, { ...spec, name: 'Arm', pduId: null })
      ).nodes[1]
    ).toEqual({ added: true, name: 'Arm', pduId: null, kind: 'panel' })
    // A registry PDU: never a zone, whatever the form sent; its default PDU may be not added yet.
    const pdu = { name: 'PDU_Center', console: 'Center', pduId: 3, kind: 'pdu' } as const
    expect(
      adoptNode(EMPTY_MAPPING, defaults, 5, pdu, reports(EMPTY_MAPPING, defaults, 5, pdu)).nodes[5]
    ).toEqual({ added: true, kind: 'pdu' })
    expect(() =>
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        1,
        { ...spec, name: ' ' },
        reports(EMPTY_MAPPING, defaults, 1, { ...spec, name: ' ' })
      )
    ).toThrow(new MappingError('Name cannot be empty'))
  })
})

describe('reset / hidden', () => {
  const seen = '2026-10-14T21:14:00.000Z'
  const busy: NodeMappingFile = {
    version: 4,
    nodes: {
      1: { name: 'Arm', hidden: true, added: true },
      2: { console: 'Left', lastSeen: seen, added: true },
      41: { added: true, name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
    }
  }

  it('reset clears registry overrides but keeps adopted nodes, added, hidden and last-seen', () => {
    expect(differingCount(defaults, busy)).toBe(2)
    const f = resetMapping(busy, defaults)
    expect(f).toEqual({
      version: 4,
      nodes: {
        1: { hidden: true, added: true },
        2: { lastSeen: seen, added: true },
        41: busy.nodes[41]
      }
    })
    expect(differingCount(defaults, f)).toBe(0)
  })

  it('resetNode: one registry board back to its defaults, still in your cockpit', () => {
    expect(resetNode(busy, defaults, 2).nodes[2]).toEqual({ lastSeen: seen, added: true })
    expect(resetNode(busy, defaults, 1).nodes[1]).toEqual({ hidden: true, added: true })
    expect(resetNode(EMPTY_MAPPING, defaults, 3)).toBe(EMPTY_MAPPING) // nothing to reset
    expect(() => resetNode(busy, defaults, 41)).toThrow(
      new MappingError('Only a registry board has defaults')
    )
  })

  it('hidden is set, cleared, and cleared again when the node reports', () => {
    const f = setHidden(ADDED, defaults, 2, true)
    expect(effectiveMapping(defaults, f).get(2)?.hidden).toBe(true)
    expect(stored(setHidden(f, defaults, 2, false))).toEqual({})
    expect(stored(clearReportedHidden(f, [1, 2]))).toEqual({})
    expect(clearReportedHidden(f, [1, 3])).toBe(f) // unchanged → same object, no write
  })

  it('only registry and adopted nodes can be hidden; un-hiding works for any id', () => {
    for (const id of [41, 2]) {
      expect(() => setHidden(EMPTY_MAPPING, defaults, id, true)).toThrow(
        new MappingError('Only a board in your cockpit can be hidden')
      )
    }
    const adoptedOnly = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      {
        name: 'Trim',
        console: 'Left',
        pduId: 3,
        kind: 'panel'
      },
      kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
    )
    expect(
      effectiveMapping(defaults, setHidden(adoptedOnly, defaults, 41, true)).get(41)?.hidden
    ).toBe(true)
    const stray: NodeMappingFile = { version: 4, nodes: { 41: { hidden: true } } }
    expect(setHidden(stray, defaults, 41, false).nodes).toEqual({})
  })
})

describe('forget (#93)', () => {
  const seen = '2026-10-14T21:14:00.000Z'

  it('keeps nothing: a registry board leaves your cockpit until it reports again', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: { 2: { name: 'Nav', hidden: true, lastSeen: seen, added: true } }
    }
    const g = forgetNode(f, defaults, 2, kinds(f, defaults))
    expect(g.nodes).toEqual({})
    expect(effectiveMapping(defaults, g).get(2)).toMatchObject({
      known: false,
      name: 'Right_Navigation'
    })
  })

  it('a PDU: the boards in your cockpit it fed lose the link, whatever the default', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: {
        2: { added: true }, // registry default zone = PDU_Right (4)
        4: { added: true },
        41: { added: true, name: 'Trim', console: 'Right', pduId: 4, kind: 'panel' },
        43: { added: true, name: 'Lamp', console: 'Right', pduId: 3, kind: 'panel' }
      }
    }
    const g = forgetNode(f, defaults, 4, kinds(f, defaults))
    expect(g.nodes).toEqual({
      2: { added: true, pduId: null },
      41: { added: true, name: 'Trim', console: 'Right', pduId: null, kind: 'panel' },
      43: f.nodes[43]
    })
    expect(effectiveMapping(defaults, g).get(2)?.pduId).toBeNull()
    // Links are not restored when it comes back.
    const back = adoptNode(
      g,
      defaults,
      4,
      {
        name: 'PDU_Right',
        console: 'Right',
        pduId: null,
        kind: 'pdu'
      },
      kinds(g, defaults, { 4: 'pdu' })
    )
    expect(effectiveMapping(defaults, back).get(2)?.pduId).toBeNull()
  })

  it('a PDU: a registry board not in your cockpit is left alone', () => {
    const f: NodeMappingFile = { version: 4, nodes: { 4: { added: true, lastSeen: seen } } }
    expect(forgetNode(f, defaults, 4, kinds(f, defaults)).nodes).toEqual({}) // Right_Navigation was never added
  })

  it('uses what the board reports for its kind when given', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: { 41: { added: true, name: 'Trim', console: 'Right', pduId: 42, kind: 'panel' } }
    }
    expect(forgetNode(f, defaults, 42, kinds(f, defaults)).nodes[41]?.pduId).toBe(42) // nothing says 42 is a PDU
    expect(forgetNode(f, defaults, 42, () => 'pdu').nodes[41]?.pduId).toBeNull()
  })
})

describe('adopted, then in the registry (#93 re-review F)', () => {
  it('a board you adopted stays in your cockpit once its NODE_ID is in NODE_IDS.md', () => {
    const f = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      {
        name: 'Left_Oxygen',
        console: 'Left',
        pduId: 3,
        kind: 'panel'
      },
      kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
    )
    // A later client bundles a NODE_IDS.md that lists 41.
    const later = registryDefaults({ ...REGISTRY, 41: { name: 'Left_Oxy', console: 'Left' } })
    expect(effectiveMapping(later, f).get(41)).toMatchObject({
      known: true,
      source: 'registry',
      name: 'Left_Oxygen', // your name, not the registry's
      pduId: 3
    })
    // Every in-cockpit check agrees: last seen, hide, edits; reset keeps it in your cockpit.
    expect(markSeen(f, later, [41], '2026-10-16T12:00:00.000Z').nodes[41]?.lastSeen).toBeDefined()
    expect(effectiveMapping(later, setHidden(f, later, 41, true)).get(41)?.hidden).toBe(true)
    expect(setNodeMapping(f, later, 41, { name: 'O2' }, kinds(f, later)).nodes[41]?.name).toBe('O2')
    expect(effectiveMapping(later, resetNode(f, later, 41)).get(41)).toMatchObject({
      known: true,
      name: 'Left_Oxy'
    })
  })
})

describe('importMapping (#93 review; D3, S4)', () => {
  const seen = '2026-10-14T21:14:00.000Z'
  it('takes everything from the file, membership included; this computer keeps its last seen', () => {
    const cur: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { added: true, lastSeen: seen, name: 'Arm' },
        2: { added: true, lastSeen: seen },
        41: {
          added: true,
          name: 'Trim',
          console: 'Left',
          pduId: null,
          kind: 'panel',
          lastSeen: seen
        }
      }
    }
    const imported: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { name: 'Armament', lastSeen: '2020-01-01T00:00:00.000Z' }, // not in that cockpit
        3: { added: true, lastSeen: seen }, // another setup's cockpit
        41: { added: true, name: 'Trim_B', console: 'Left', pduId: null, kind: 'panel' }
      }
    }
    expect(importMapping(cur, defaults, imported).nodes).toEqual({
      1: { name: 'Armament' }, // leaves, with nothing observed kept
      3: { added: true }, // joins; the other computer's last seen is not imported
      41: {
        added: true,
        name: 'Trim_B',
        console: 'Left',
        pduId: null,
        kind: 'panel',
        lastSeen: seen
      }
    }) // 2: the file does not have it, so it leaves
  })

  it('never hides a board on the bus (#93 re-review K): Hide is offline-only', () => {
    const cur: NodeMappingFile = { version: 4, nodes: { 1: { added: true }, 2: { added: true } } }
    const imported: NodeMappingFile = {
      version: 4,
      nodes: { 1: { added: true, hidden: true, name: 'Arm' }, 2: { added: true, hidden: true } }
    }
    expect(importMapping(cur, defaults, imported, [1]).nodes).toEqual({
      1: { name: 'Arm', added: true }, // online: its other settings come in, not the hidden flag
      2: { hidden: true, added: true } // offline: hidden as the file says
    })
  })

  it('stores no hidden flag on a board outside your cockpit (S4)', () => {
    const imported: NodeMappingFile = {
      version: 4,
      nodes: { 2: { hidden: true, name: 'Nav' }, 52: { hidden: true } }
    }
    expect(importMapping(EMPTY_MAPPING, defaults, imported).nodes).toEqual({ 2: { name: 'Nav' } })
  })

  it('an adopted board the file drops leaves, with nothing left behind', () => {
    const cur: NodeMappingFile = {
      version: 4,
      nodes: {
        41: {
          added: true,
          name: 'Trim',
          console: 'Left',
          pduId: null,
          kind: 'panel',
          lastSeen: seen
        }
      }
    }
    expect(importMapping(cur, defaults, EMPTY_MAPPING).nodes).toEqual({})
  })
})

describe('markSeen (#93)', () => {
  const at = '2026-10-16T12:00:00.000Z'

  it('records boards you added; a registry board not added is not joined by reporting', () => {
    expect(markSeen(ADDED, defaults, [2], at).nodes[2]).toEqual({ added: true, lastSeen: at })
    expect(markSeen(EMPTY_MAPPING, defaults, [2], at)).toBe(EMPTY_MAPPING)
  })

  it('records adopted boards too, never a new NODE_ID', () => {
    const adopted = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      {
        name: 'Trim',
        console: 'Left',
        pduId: null,
        kind: 'panel'
      },
      kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
    )
    const f = markSeen(adopted, defaults, [41, 50], at)
    expect(f.nodes[41]?.lastSeen).toBe(at)
    expect(f.nodes[50]).toBeUndefined()
    expect(markSeen(EMPTY_MAPPING, defaults, [50], at)).toBe(EMPTY_MAPPING)
  })
})

describe('renderer input: on/off values and no-op changes', () => {
  it('hide accepts only a real boolean', () => {
    for (const bad of ['no', 'false', 1, undefined, null]) {
      const on = bad as unknown as boolean
      expect(() => setHidden(ADDED, defaults, 2, on)).toThrow(
        new MappingError('Invalid on/off value')
      )
    }
    expect(stored(setHidden(ADDED, defaults, 2, true))).toEqual({ 2: { hidden: true } })
  })

  it('forget checks the NODE_ID', () => {
    for (const bad of [NaN, 0, 64, '3']) {
      expect(() =>
        forgetNode(EMPTY_MAPPING, defaults, bad as number, kinds(EMPTY_MAPPING, defaults))
      ).toThrow(MappingError)
    }
  })

  it('a change that changes nothing returns the same object (no write)', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: { 1: { name: 'Arm', hidden: true, added: true } }
    }
    expect(forgetNode(f, defaults, 41, kinds(f, defaults))).toBe(f)
    expect(setHidden(f, defaults, 1, true)).toBe(f)
    expect(setHidden(f, defaults, 2, false)).toBe(f)
    expect(setNodeMapping(f, defaults, 1, { name: 'Arm' }, kinds(f, defaults))).toBe(f)
    expect(forgetNode(f, defaults, 1, kinds(f, defaults)).nodes).toEqual({})
  })
})

describe('power zones', () => {
  const trim: AdoptSpec = { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
  const withAux = adoptNode(
    ADDED,
    defaults,
    42,
    {
      name: 'PDU_Aux',
      console: 'Left',
      pduId: null,
      kind: 'pdu'
    },
    kinds(ADDED, defaults, { 42: 'pdu' })
  )

  it('a PDU has no power zone', () => {
    expect(() => setNodeMapping(ADDED, defaults, 3, { pduId: 4 }, kinds(ADDED, defaults))).toThrow(
      new MappingError('A PDU has no power zone')
    )
    expect(() =>
      setNodeMapping(withAux, defaults, 42, { pduId: 3 }, kinds(withAux, defaults))
    ).toThrow(new MappingError('A PDU has no power zone'))
    expect(setNodeMapping(ADDED, defaults, 3, { pduId: null }, kinds(ADDED, defaults))).toBe(ADDED)
  })

  it('a panel is zoned only to a registry or adopted PDU', () => {
    const notPdu = new MappingError('Power zone must be a PDU')
    const set = (f: NodeMappingFile, pduId: number) => () =>
      setNodeMapping(f, defaults, 1, { pduId }, kinds(f, defaults))
    expect(set(ADDED, 1)).toThrow(notPdu) // itself
    expect(set(ADDED, 2)).toThrow(notPdu) // another panel
    expect(set(ADDED, 42)).toThrow(notPdu) // not adopted
    expect(set(ADDED, 3)().nodes[1]).toEqual({ added: true, pduId: 3 }) // registry PDU
    expect(set(withAux, 42)().nodes[1]).toEqual({ added: true, pduId: 42 }) // adopted PDU
    expect(
      setNodeMapping(ADDED, defaults, 1, { pduId: null }, kinds(ADDED, defaults)).nodes[1]
    ).toEqual({
      added: true,
      pduId: null
    })
  })

  it('adopting a panel applies the same rule', () => {
    const notPdu = new MappingError('Power zone must be a PDU')
    expect(() =>
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        41,
        { ...trim, pduId: 41 },
        kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
      )
    ).toThrow(notPdu)
    expect(() =>
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        41,
        { ...trim, pduId: 1 },
        kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
      )
    ).toThrow(notPdu)
    expect(() =>
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        41,
        { ...trim, pduId: 42 },
        kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
      )
    ).toThrow(notPdu)
    expect(
      adoptNode(
        withAux,
        defaults,
        41,
        { ...trim, pduId: 42 },
        kinds(withAux, defaults, { 41: 'panel' })
      ).nodes[41]?.pduId
    ).toBe(42)
    expect(
      adoptNode(
        EMPTY_MAPPING,
        defaults,
        41,
        { ...trim, pduId: 5 },
        kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
      ).nodes[41]?.pduId
    ).toBe(5)
  })
})

describe('differingCount matches what Reset changes', () => {
  it('a reset with nothing to reset returns the same object (no write)', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { hidden: true, lastSeen: '2026-10-14T21:14:00.000Z' },
        41: { added: true, name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
      }
    }
    expect(differingCount(defaults, f)).toBe(0)
    expect(resetMapping(f, defaults)).toBe(f)
  })
})

describe('reset preview and forgetting adopted nodes', () => {
  const file: NodeMappingFile = {
    version: 4,
    nodes: {
      1: { name: 'Arm', pduId: 3, hidden: true },
      2: { console: 'Left' },
      4: { name: 'PDU_R' }, // a PDU renamed: zones pointing at it show the new name
      41: { added: true, name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' },
      55: { hidden: true } // stray flag on an unknown id
    }
  }

  it('lists every changed field, with zones by name', () => {
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

  it('forgetAdopted drops the listed adopted nodes only; stray flags stay', () => {
    expect(resetMapping(file, defaults, { forgetAdopted: true })).toEqual({
      version: 4,
      nodes: { 1: { hidden: true }, 55: { hidden: true } }
    })
    const adoptedOnly: NodeMappingFile = { version: 4, nodes: { 41: file.nodes[41]! } }
    expect(resetMapping(adoptedOnly, defaults)).toBe(adoptedOnly) // nothing to reset
    expect(resetMapping(adoptedOnly, defaults, { forgetAdopted: true }).nodes).toEqual({})
  })

  it('removes exactly what the preview lists', () => {
    const listed = resetPreview(defaults, file).adopted.map((a) => a.nodeId)
    const after = resetMapping(file, defaults, { forgetAdopted: true })
    const gone = Object.keys(file.nodes)
      .map(Number)
      .filter((id) => !defaults.has(id) && !(id in after.nodes))
    expect(gone).toEqual(listed)
  })

  it('refuses a malformed reset request', () => {
    for (const bad of [null, 'yes', [], { forgetAdopted: 'yes' }]) {
      expect(() => resetMapping(file, defaults, bad as never)).toThrow(
        new MappingError('Invalid reset request')
      )
    }
  })
})

describe('file v4: one marker, the reported kind, only what you changed (S1, M9)', () => {
  const seen = '2026-10-14T21:14:00.000Z'
  const later = registryDefaults({ ...REGISTRY, 41: { name: 'Left_Oxy', console: 'Left' } })

  it('upgrades v3 losslessly: every field kept, and an adopted board gets the one marker', () => {
    const v3 = {
      version: 3,
      nodes: {
        1: { added: true, name: 'Arm', console: 'Left', pduId: null, hidden: true, lastSeen: seen },
        2: { name: 'Nav' }, // a registry board outside your cockpit (an import brought it)
        41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel', hidden: true, lastSeen: seen }
      }
    }
    const f = sanitizeNodeMapping(v3)
    expect(f).toEqual({
      version: 4,
      nodes: { 1: v3.nodes[1], 2: v3.nodes[2], 41: { ...v3.nodes[41], added: true } }
    })
    const m = effectiveMapping(defaults, f)
    expect([1, 2, 41].map((id) => m.get(id)?.known)).toEqual([true, false, true])
    expect(m.get(41)).toMatchObject({ name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' })
    expect(m.get(1)).toMatchObject({ name: 'Arm', console: 'Left', pduId: null, hidden: true })
  })

  it('upgrades v2, v1 and unversioned files losslessly, by the old rules', () => {
    for (const version of [2, 1, undefined]) {
      const old = {
        version,
        ignored: [9],
        nodes: {
          1: { lastSeen: seen }, // seen
          2: { console: 'Left' }, // placed
          3: { name: 'PDU_L' }, // renamed
          4: { hidden: true }, // hidden
          5: { pduId: null }, // zoned to none: placed
          41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel', lastSeen: seen } // adopted
        }
      }
      const f = sanitizeNodeMapping(old)
      const marked = Object.fromEntries(
        Object.entries(old.nodes).map(([k, o]) => [k, { ...o, added: true }])
      )
      expect(f, `version ${version}`).toEqual({ version: 4, nodes: marked })
    }
  })

  it('reads a v4 file as written: an entry without the marker never joins by a reload', () => {
    const v4 = {
      version: 4,
      nodes: {
        2: { name: 'Nav' },
        41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' } // complete, but not marked
      }
    }
    const f = sanitizeNodeMapping(v4)
    expect(f).toEqual(v4)
    const m = effectiveMapping(defaults, f)
    expect(m.get(2)?.known).toBe(false)
    expect(m.has(41)).toBe(false)
  })

  it('bug 1: a board renamed to its NODE_IDS.md name stays in your cockpit', () => {
    // Adopted while NODE_IDS.md did not list 41; a later one does, as "Left_Oxy".
    const f = adoptNode(
      EMPTY_MAPPING,
      defaults,
      41,
      {
        name: 'Left_Oxygen',
        console: 'Left',
        pduId: 3,
        kind: 'panel'
      },
      kinds(EMPTY_MAPPING, defaults, { 41: 'panel' })
    )
    const g = setNodeMapping(f, later, 41, { name: 'Left_Oxy' }, kinds(f, later))
    expect(g.nodes[41]?.name).toBeUndefined() // the registry's name is not stored…
    expect(effectiveMapping(later, g).get(41)).toMatchObject({ known: true, name: 'Left_Oxy' })
    // …so a still later NODE_IDS.md name reaches it, and it can still be edited.
    const latest = registryDefaults({ ...REGISTRY, 41: { name: 'Left_O2', console: 'Left' } })
    expect(effectiveMapping(latest, g).get(41)).toMatchObject({ known: true, name: 'Left_O2' })
    expect(
      setNodeMapping(g, latest, 41, { console: 'Right' }, kinds(g, latest)).nodes[41]?.console
    ).toBe('Right')
    // A registry board renamed back to its NODE_IDS.md name stays in too.
    const named = setNodeMapping(ADDED, defaults, 2, { name: 'Nav' }, kinds(ADDED, defaults))
    const nav = setNodeMapping(
      named,
      defaults,
      2,
      { name: 'Right_Navigation' },
      kinds(named, defaults)
    )
    expect(effectiveMapping(defaults, nav).get(2)).toMatchObject({ known: true, differs: false })
  })

  it('bug 3: the kind a board reported is stored when it is added, and read while it is offline', () => {
    // Right_Navigation's NODE_ID (a registry panel) answered as a PDU when it was added.
    const spec = { name: 'Right_Navigation', console: 'Right', pduId: null, kind: 'pdu' } as const
    const f = adoptNode(EMPTY_MAPPING, defaults, 2, spec, () => 'pdu')
    expect(f.nodes[2]).toEqual({ added: true, kind: 'pdu' })
    expect(effectiveMapping(defaults, f).get(2)?.kind).toBe('pdu') // nothing on the bus now
    expect(resetNode(f, defaults, 2).nodes[2]?.kind).toBe('pdu') // not an override: reset keeps it
    // Without a report (a v3 file, say), a registry board reads as its registry kind.
    expect(effectiveMapping(defaults, ADDED).get(2)?.kind).toBe('panel')
  })

  it('bug 3: the kind is stored when a board in your cockpit reports, never for one outside it', () => {
    const f = recordKinds(ADDED, defaults, [
      [2, 'pdu'],
      [1, 'panel'],
      [41, 'panel'] // not in your cockpit
    ])
    expect(f.nodes[2]).toEqual({ added: true, kind: 'pdu' })
    expect(f.nodes[1]).toEqual({ added: true, kind: 'panel' })
    expect(f.nodes[41]).toBeUndefined()
    expect(recordKinds(f, defaults, [[2, 'pdu']])).toBe(f) // unchanged → same object, no write
    expect(recordKinds(EMPTY_MAPPING, defaults, [[2, 'pdu']])).toBe(EMPTY_MAPPING)
  })

  it('Forget of a PDU that has not reported this session unlinks its boards, by its stored kind', () => {
    const f: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { added: true, kind: 'pdu' }, // a registry panel NODE_ID that reported PDU
        2: { added: true, pduId: 1 },
        41: { added: true, name: 'Trim', console: 'Center', pduId: 1, kind: 'panel' }
      }
    }
    // Nothing on the bus says what it is this session: main's KindOf has only the stored kind.
    const g = forgetNode(f, defaults, 1, kinds(f, defaults))
    expect(g.nodes[1]).toBeUndefined()
    expect(g.nodes[2]).toEqual({ added: true, pduId: null })
    expect(g.nodes[41]?.pduId).toBeNull()
  })

  it('Reset never links a board back to a PDU you forgot', () => {
    const named = setNodeMapping(ADDED, defaults, 2, { name: 'Nav' }, kinds(ADDED, defaults))
    const forgot = forgetNode(named, defaults, 4, kinds(named, defaults)) // PDU_Right, Right_Navigation's default zone
    expect(forgot.nodes[2]).toEqual({ added: true, name: 'Nav', pduId: null })
    expect(differingCount(defaults, forgot)).toBe(1) // the name only
    expect(resetPreview(defaults, forgot).rows).toEqual([
      { nodeId: 2, node: 'Right_Navigation', field: 'name', from: 'Nav', to: 'Right_Navigation' }
    ])
    for (const reset of [resetMapping(forgot, defaults), resetNode(forgot, defaults, 2)]) {
      expect(reset.nodes[2]).toEqual({ added: true, pduId: null })
      expect(effectiveMapping(defaults, reset).get(2)?.pduId).toBeNull()
      expect(differingCount(defaults, reset)).toBe(0)
    }
    // Once the PDU is in your cockpit again, the board's none is a difference Reset undoes.
    const pdu = { name: 'PDU_Right', console: 'Right', pduId: null, kind: 'pdu' } as const
    const back = adoptNode(
      resetMapping(forgot, defaults),
      defaults,
      4,
      pdu,
      reports(resetMapping(forgot, defaults), defaults, 4, pdu)
    )
    expect(differingCount(defaults, back)).toBe(1)
    expect(effectiveMapping(defaults, resetMapping(back, defaults)).get(2)?.pduId).toBe(4)
  })

  it('M9: an unregistered id a legacy upgrade marked is neither shown nor editable', () => {
    const f = sanitizeNodeMapping({ version: 2, nodes: { 30: { name: 'Old', lastSeen: seen } } })
    expect(f.nodes[30]).toEqual({ name: 'Old', lastSeen: seen, added: true })
    expect(effectiveMapping(defaults, f).has(30)).toBe(false)
    expect(() => setNodeMapping(f, defaults, 30, { name: 'X' }, kinds(f, defaults))).toThrow(
      /add it first/
    )
    expect(() => setHidden(f, defaults, 30, true)).toThrow(
      new MappingError('Only a board in your cockpit can be hidden')
    )
    expect(markSeen(f, defaults, [30], '2026-10-16T12:00:00.000Z')).toBe(f)
    expect(recordKinds(f, defaults, [[30, 'panel']])).toBe(f)
    expect(forgettable(defaults, f)).toEqual([])
    // A NODE_IDS.md that lists it puts it in your cockpit, shown and editable alike.
    const listed = registryDefaults({ ...REGISTRY, 30: { name: 'Left_Old', console: 'Left' } })
    expect(effectiveMapping(listed, f).get(30)).toMatchObject({ known: true, name: 'Old' })
    expect(setNodeMapping(f, listed, 30, { name: 'X' }, kinds(f, listed)).nodes[30]?.name).toBe('X')
  })

  it('import: a v3 section is upgraded as the file is, a v4 one read as written, a newer one refused', () => {
    const adopted = { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
    expect(
      checkImportedMapping({ version: 3, nodes: { 2: { added: true }, 41: adopted } })
    ).toEqual({
      ok: true,
      value: { version: 4, nodes: { 2: { added: true }, 41: { ...adopted, added: true } } }
    })
    const v4 = { version: 4, nodes: { 2: { added: true, kind: 'pdu' }, 41: adopted } }
    expect(checkImportedMapping(v4)).toEqual({ ok: true, value: v4 })
    expect(checkImportedMapping({ version: 5, nodes: {} })).toEqual({
      ok: false,
      reason: 'it was written by a newer client'
    })
  })

  it('import: this computer keeps the kind a board reported here where the file has none', () => {
    const cur: NodeMappingFile = { version: 4, nodes: { 2: { added: true, kind: 'pdu' } } }
    const imported: NodeMappingFile = { version: 4, nodes: { 2: { added: true, name: 'Nav' } } }
    expect(importMapping(cur, defaults, imported).nodes[2]).toEqual({
      added: true,
      name: 'Nav',
      kind: 'pdu'
    })
    const told: NodeMappingFile = { version: 4, nodes: { 2: { added: true, kind: 'panel' } } }
    expect(importMapping(cur, defaults, told).nodes[2]?.kind).toBe('panel') // as written
    expect(importMapping(cur, defaults, EMPTY_MAPPING).nodes).toEqual({}) // it leaves
  })
})
