import { describe, expect, it } from 'vitest'
import type { NodeModel, NodeModelEntry, NodeRegistryInfo } from '@shared/nodes/ipc'
import {
  hiddenRow,
  importDoneText,
  importRowKey,
  importSubtitle,
  registryName,
  registryOnBus,
  registrySummary,
  resetButtonLabel,
  resetRowDesc
} from './settings-view'

describe('reset texts', () => {
  it('describes the row and labels the confirm button', () => {
    expect(resetRowDesc(0)).toBe('Every node matches NODE_IDS.md')
    expect(resetRowDesc(1)).toMatch(/^1 node differs from NODE_IDS.md/)
    expect(resetRowDesc(3)).toMatch(/^3 nodes differ from NODE_IDS.md/)
    expect(resetButtonLabel(3, 0)).toBe('Reset 3 nodes')
    expect(resetButtonLabel(1, 2)).toBe('Reset 1 node + forget 2')
    expect(resetButtonLabel(0, 1)).toBe('Forget 1 adopted node')
    expect(resetButtonLabel(0, 0)).toBe('Reset') // nothing to do: never "Forget 0 …"
  })
})

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

describe('import texts', () => {
  it('subtitle, row keys and the done line', () => {
    const at = new Date(2026, 9, 12, 21, 2).toISOString()
    expect(importSubtitle({ fileName: 'a.json', exportedAt: at, client: '0.2.0' })).toBe(
      'a.json · exported 2026-10-12 21:02 · client v0.2.0'
    )
    expect(importSubtitle({ fileName: 'a.json', exportedAt: 'x' })).toBe('a.json')
    const labels = ['Roll', 'Pitch', 'Throttle']
    expect(importRowKey({ k: 'DCS host' }, labels, false)).toBe('DCS host')
    expect(importRowKey({ k: 'Axis 2', axis: 2, board: 'A7' }, labels, false)).toBe('Throttle')
    expect(importRowKey({ k: 'Axis 2', axis: 2, board: 'A7' }, labels, true)).toBe('Throttle · A7')
    expect(importRowKey({ k: 'Axis 9', axis: 9 }, labels, false)).toBe('Axis 9')
    expect(importDoneText(1)).toBe('Applied 1 section')
    expect(importDoneText(3, '/u/backups/skyhawk-config-x.json')).toBe(
      'Applied 3 sections · backup saved as skyhawk-config-x.json'
    )
  })
})

describe('hiddenRow (#76)', () => {
  it('uses the name and console the Cockpit showed: a renamed registry node', () => {
    expect(hiddenRow({ nodeId: 2, name: 'Nav_Repeater', console: 'Left' })).toEqual({
      nodeId: 2,
      label: 'Nav_Repeater',
      desc: 'Left console · returns when it reports again'
    })
  })

  it('an adopted node keeps the name the user gave it', () => {
    expect(hiddenRow({ nodeId: 41, name: 'Left_Lights', console: 'Left' }).label).toBe(
      'Left_Lights'
    )
  })

  it('no console, no console part', () => {
    expect(hiddenRow({ nodeId: 41, name: 'Spare', console: '' }).desc).toBe(
      'returns when it reports again'
    )
  })
})
