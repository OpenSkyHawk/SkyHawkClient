// "On the bus" is one rule for every surface (X2 / R5, #132): node-model.ts onBusNow(live). While
// the Gateway is unplugged the Cockpit's "New on the bus" and its strays, the Overview's
// new-devices notice, Connection › Connected nodes and Settings › About's On the bus all go quiet,
// whatever the last model said; when the link is back they return.
import { describe, expect, it } from 'vitest'
import { COCKPIT_IDLE, type CockpitSnapshot, type NodeRegistryInfo } from '@shared/nodes'
import type { DeviceState } from '@shared/gateway'
import { modelNode as node, nodeModel as model } from '../../../test-fixtures/nodes'
import { buildCockpitSnapshot } from '.'
import { CockpitSnapshotHost } from '../cockpit-host'

const REG: NodeRegistryInfo = {
  file: 'Firmware/NODE_IDS.md',
  commit: '22b6a87e73068ca2bfd964d067af1247771d5854',
  date: '2026-10-15',
  nodes: [
    { nodeId: 0, name: 'PanelBridge', console: '—', kind: 'bridge' },
    { nodeId: 1, name: 'Center_Armament', console: 'Center', kind: 'panel' },
    { nodeId: 2, name: 'Right_Navigation', console: 'Right', kind: 'panel' }
  ]
}

/**
 * The last model before the link drops: Center_Armament (#1) online, Right_Navigation (#2)
 * offline, a new panel group (#41) waiting to be adopted, and an unidentified new board (#9) seen
 * long enough ago to be a stray.
 */
const LAST = model([
  node(1, { name: 'Center_Armament' }),
  node(2, { name: 'Right_Navigation', console: 'Right', availability: 'offline', offlineAt: 0 }),
  node(9, { name: 'Node 9', console: null, source: 'new', firstSeenAt: 0 }),
  node(41, { name: 'Node 41', console: null, source: 'new', identified: 'panel', firstSeenAt: 0 })
])

function snapshot(state: DeviceState): CockpitSnapshot {
  return buildCockpitSnapshot({
    model: LAST,
    telemetry: [],
    device: { state },
    peakW: 0,
    registry: REG,
    now: 60_000,
    rev: 1
  }).snapshot
}

/** What each "on the bus" surface says. */
function onTheBus(s: CockpitSnapshot) {
  return {
    newOnTheBus: s.attention.newCount,
    strays: s.attention.items.filter((i) => i.stray).map((i) => i.nodeId),
    bandStrays: s.band.band.total - s.views.filter((v) => v.entry.source !== 'new').length,
    newDevices: s.overview.newDevices,
    nodesCard: s.nodesCard,
    aboutOnBus: s.settings.registry.rows.map((r) => r.onBus.text)
  }
}

describe('every "on the bus" surface goes quiet with the link down (X2 / R5, #132)', () => {
  it('link up: the surfaces read the model', () => {
    const up = onTheBus(snapshot('connected'))
    expect(up.newOnTheBus).toBe(1)
    expect(up.strays).toEqual([9])
    expect(up.bandStrays).toBe(1)
    expect(up.newDevices).toEqual({ count: 1, panels: 1, pdus: 0, registry: 0 })
    expect(up.nodesCard).toMatchObject({ known: 2, healthy: 1, off: 1 })
    expect(up.nodesCard.rows.map((r) => r.nodeId)).toEqual([2])
    expect(up.aboutOnBus).toEqual(['serial link', 'yes', 'offline'])
  })

  for (const state of ['no-device', 'disconnected'] as const) {
    it(`${state}: none of them says anything about the bus`, () => {
      const down = onTheBus(snapshot(state))
      expect(down).toEqual({
        newOnTheBus: 0,
        strays: [],
        bandStrays: 0,
        newDevices: null,
        nodesCard: COCKPIT_IDLE.nodesCard,
        aboutOnBus: ['no device', '—', '—']
      })
    })
  }

  it('unplugged and plugged back in, with no new model meanwhile: quiet, then back', () => {
    // Node pushes stop while the link is down, so the host still holds the last model: only the
    // link changes, as the app's `device:status` pushes say.
    const device: { state: DeviceState } = { state: 'connected' }
    const pushed: CockpitSnapshot[] = []
    const host = new CockpitSnapshotHost((s) => pushed.push(s), {
      device: () => device,
      registry: () => REG
    })
    host.modelPushed(LAST)
    const before = onTheBus(host.state())
    expect(before.newOnTheBus).toBe(1)
    device.state = 'no-device'
    host.linkChanged()
    expect(onTheBus(host.state())).toMatchObject({ newOnTheBus: 0, strays: [], newDevices: null })
    expect(onTheBus(host.state()).aboutOnBus).toEqual(['no device', '—', '—'])
    device.state = 'connected'
    host.linkChanged()
    expect(onTheBus(host.state())).toEqual(before)
    host.dispose()
  })
})
