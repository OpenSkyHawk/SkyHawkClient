// Every renderer → main intent, registered on ipcMain. Each topic registers its own (its ipc.ts);
// app answers the three that span topics: the relay:status rehydrate bundle and the debug tools.
//
// The registration order is today's, kept on purpose (R2.3c): it interleaves topics (config, dcs,
// app, gateway, hid, nodes, gateway, dcs, events, app, dcs, calibration), so the topics register
// into a collector and IPC_ORDER hands the handlers to ipcMain in that order.
import { shell } from 'electron'
import { APP_CTRL, type CtrlChannel, type IpcListener, type IpcRegistrar } from '@shared/app'
import { registerConfigIpc, type ConfigTransfer } from '../config'
import { registerDcsIpc } from '../dcs'
import { registerEventsIpc } from '../events'
import { listSerialPorts, registerGatewayIpc } from '../gateway'
import { registerHidIpc } from '../hid'
import { registerCalibrationIpc } from '../hid/calibration'
import { registerNodesIpc } from '../nodes'
import type { AppServices } from './app-services'
import { debugLog, debugLogPath } from './debug-log'
import type { Dialogs } from './dialogs'

/** Every intent channel, in the order ipcMain registers it. */
const IPC_ORDER = [
  'config:get',
  'config:set',
  'config:export',
  'config:import-open',
  'config:import-apply',
  'relay:start',
  'relay:stop',
  'relay:status',
  'device:connect',
  'device:disconnect',
  'hid:availability',
  'nodes:refresh',
  'nodes:get',
  'node-mapping:set',
  'node-mapping:adopt',
  'node-mapping:forget',
  'node-mapping:reset-node',
  'node-mapping:reset',
  'node-mapping:reset-preview',
  'nodes:registry',
  'node-mapping:hide',
  'serial:monitor',
  'log:export',
  'events:get',
  'events:clear',
  'events:export',
  'debug:dump-ports',
  'debug:reveal',
  'capture:toggle',
  'replay:open',
  // The calibration workflow's intents (R3.1), after every channel that was here before them.
  'cal:open',
  'cal:close',
  'cal:select-axis',
  'cal:start-capture',
  'cal:retry',
  'cal:set-self-centring',
  'cal:save',
  'cal:restore',
  'cal:delete-axis',
  'cal:set-restore-open'
] as const satisfies readonly CtrlChannel[]

/** IPC_ORDER's type when it lists every channel; otherwise the channels it leaves out. */
type EveryChannel<T extends readonly CtrlChannel[]> = [Exclude<CtrlChannel, T[number]>] extends [
  never
]
  ? T
  : { unordered: Exclude<CtrlChannel, T[number]> }
// A CTRL channel missing from IPC_ORDER fails the typecheck here, and names the channel.
const order: EveryChannel<typeof IPC_ORDER> = IPC_ORDER

export interface IpcDeps {
  services: AppServices
  transfer: ConfigTransfer
  dialogs: Dialogs
}

export function registerIpc(ipcMain: IpcRegistrar, deps: IpcDeps): void {
  const { services, transfer, dialogs } = deps
  const handlers = new Map<CtrlChannel, IpcListener>()
  const ipc: IpcRegistrar = {
    handle(channel, listener) {
      // As ipcMain does: one handler per channel.
      if (handlers.has(channel)) throw new Error(`a second handler for ${channel}`)
      handlers.set(channel, listener)
    }
  }

  registerConfigIpc(ipc, { settings: services.settings, transfer, dialogs })
  registerDcsIpc(ipc, { relay: services.relay, recorder: services.recorder, dialogs })
  registerGatewayIpc(ipc, {
    connection: services.connection,
    serialMonitor: services.serialMonitor
  })
  registerHidIpc(ipc)
  registerNodesIpc(ipc, { nodes: services.nodes })
  registerCalibrationIpc(ipc, { calibration: services.calibration })
  registerEventsIpc(ipc, { journal: services.journal, dialogs })

  ipc.handle(APP_CTRL.relayStatus, () => services.status())
  ipc.handle(APP_CTRL.debugDumpPorts, async () => {
    const ports = await listSerialPorts()
    debugLog('serial.list', ports, true) // force-write regardless of the toggle
    return { path: debugLogPath(), count: ports.length }
  })
  ipc.handle(APP_CTRL.debugReveal, () => {
    shell.showItemInFolder(debugLogPath())
  })

  for (const channel of order) {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`no handler for ${channel}`)
    ipcMain.handle(channel, listener)
  }
}
