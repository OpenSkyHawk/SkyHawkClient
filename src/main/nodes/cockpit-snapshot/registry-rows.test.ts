// Ported from the renderer's settings-view.test.ts (R3.2b): the registry rows Settings › About
// shows, now built in main (registry-rows.ts). Same cases, same expected values.
import { describe, expect, it } from 'vitest'
import type { NodeModel, NodeModelEntry, NodeRegistryInfo } from '@shared/nodes'
import { registryName, registryOnBus, registrySummary, settingsNodes } from './registry-rows'

const REG: NodeRegistryInfo = {
  file: 'Firmware/NODE_IDS.md',
  commit: '22b6a87e73068ca2bfd964d067af1247771d5854',
  date: '2026-10-15',
  nodes: [
    { nodeId: 0, name: 'PanelBridge', console: '—', kind: 'bridge' },
    { nodeId: 1, name: 'Center_Armament', console: 'Center', kind: 'panel' },
    { nodeId: 2, name: 'Right_Navigation', console: 'Right', kind: 'panel' },
    { nodeId: 3, name: 'PDU_Left', console: 'Left', kind: 'pdu' },
    { nodeId: 4, name: 'PDU_Right', console: 'Right', kind: 'pdu' },
    { nodeId: 5, name: 'PDU_Center', console: 'Center', kind: 'pdu' }
  ]
}

describe('registry', () => {
  it('summarises the bundled registry', () => {
    expect(registrySummary(REG)).toBe('NODE_IDS.md · 6 nodes: 3 PDUs, 2 panel groups, Gateway')
  })

  it('names the bridge row Gateway, whatever NODE_IDS.md calls it (#94)', () => {
    expect(REG.nodes.map(registryName)[0]).toBe('Gateway')
    expect(REG.nodes.slice(1).map(registryName)).toEqual(REG.nodes.slice(1).map((n) => n.name))
  })

  it('"On the bus" comes from the link and the roster, and says when there is no data', () => {
    const e = (nodeId: number, availability: NodeModelEntry['availability']) =>
      ({ nodeId, availability }) as NodeModelEntry
    const model = {
      nodes: [e(1, 'online'), e(2, 'offline'), e(3, 'unknown')],
      hidden: [5]
    } as unknown as NodeModel
    const col = (id: number, m?: NodeModel, up = true) => registryOnBus(id, m, up)
    expect(col(0)).toEqual({ text: 'serial link', dot: 'on' })
    expect(col(0, model, false)).toEqual({ text: 'no device', dot: '' })
    expect([1, 2, 3, 4, 5].map((id) => col(id, model).text)).toEqual([
      'yes',
      'offline',
      '—',
      '—', // never reported: not in your cockpit (#93)
      'hidden'
    ])
    expect(col(1, undefined).text).toBe('—')
  })
})

// New in R3.2b: the section the snapshot pushes, as CockpitSection and AboutSection read the model.
describe('settingsNodes', () => {
  const entry = (nodeId: number, over: Partial<NodeModelEntry> = {}) =>
    ({ nodeId, availability: 'online', source: 'registry', ...over }) as NodeModelEntry
  const m = (nodes: NodeModelEntry[], over: Partial<NodeModel> = {}) =>
    ({ nodes, hidden: [], hiddenNodes: [], differingCount: 0, ...over }) as unknown as NodeModel

  it('Reset… is offered when a board differs, or an adopted board is on the plan', () => {
    expect(settingsNodes(m([entry(1)]), REG, true)).toMatchObject({ differing: 0, canReset: false })
    expect(settingsNodes(m([entry(1)], { differingCount: 2 }), REG, true)).toMatchObject({
      differing: 2,
      canReset: true
    })
    expect(settingsNodes(m([entry(41, { source: 'adopted' })]), REG, true).canReset).toBe(true)
  })

  it('counts an adopted board that is hidden (X1: still in your cockpit), and has nothing before a model', () => {
    const trim = {
      nodeId: 41,
      name: 'Left_Trim',
      console: 'Left',
      kind: 'panel',
      source: 'adopted'
    } as const
    const hiddenAdopted = m([entry(1)], { hidden: [41], hiddenNodes: [trim] })
    expect(settingsNodes(hiddenAdopted, REG, true)).toMatchObject({
      canReset: true,
      hidden: [trim]
    })
    // A hidden registry board that matches NODE_IDS.md is nothing to reset: the test can fail.
    const hiddenRegistry = m([entry(1)], {
      hidden: [41],
      hiddenNodes: [{ ...trim, source: 'registry' }]
    })
    expect(settingsNodes(hiddenRegistry, REG, true).canReset).toBe(false)
    expect(settingsNodes(undefined, REG, true)).toMatchObject({
      differing: 0,
      canReset: false,
      hidden: []
    })
  })

  it('lists each registry row with its name, console and On the bus, before and after the model', () => {
    const s = settingsNodes(m([entry(1), entry(2, { availability: 'offline' })]), REG, false)
    expect(s.registry.summary).toBe(registrySummary(REG))
    expect(
      s.registry.rows.map((r) => [r.nodeId, r.name, r.console, r.onBus.text, r.unloaded.text])
    ).toEqual([
      [0, 'Gateway', '—', 'no device', 'no device'],
      // The link is down: no CAN row is on the bus or offline by the last model (X2, #132).
      [1, 'Center_Armament', 'Center', '—', '—'],
      [2, 'Right_Navigation', 'Right', '—', '—'],
      [3, 'PDU_Left', 'Left', '—', '—'],
      [4, 'PDU_Right', 'Right', '—', '—'],
      [5, 'PDU_Center', 'Center', '—', '—']
    ])
  })

  it('has no rows before main knows the registry (the launch snapshot)', () => {
    expect(settingsNodes(undefined, undefined, false).registry).toEqual({ summary: '', rows: [] })
  })
})
