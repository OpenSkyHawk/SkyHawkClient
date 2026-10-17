// The zustand stores are module singletons: snapshot each topic store's initial state once, restore
// them all per test (the setup file does this before every test). Importing the IPC adapter binds
// the stores' intents to `window.skyhawk`, as the app's entry does.
import '../src/app/ipc-adapter'
import { useNav } from '../src/app/kit'
import { useConfigStore } from '../src/config'
import { useDcsStore } from '../src/dcs'
import { useEventsStore } from '../src/events'
import { useGatewayStore } from '../src/gateway'
import { useHidStore } from '../src/hid'
import { useCalibrationStore } from '../src/hid/calibration'
import { useNodesStore } from '../src/nodes'

interface Store<T> {
  getState(): T
  setState(state: T, replace: true): void
}

const stores: Store<unknown>[] = [
  useNav,
  useGatewayStore,
  useDcsStore,
  useNodesStore,
  useHidStore,
  useCalibrationStore,
  useEventsStore,
  useConfigStore
] as Store<unknown>[]

const initial = stores.map((s) => s.getState())

export function resetStore(): void {
  stores.forEach((s, i) => s.setState(initial[i], true))
}
