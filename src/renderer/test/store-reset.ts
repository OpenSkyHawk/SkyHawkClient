// The zustand store is a module singleton: snapshot its initial state once, restore it per test
// (the setup file does this before every test).
import { useStore, type AppState } from '../src/store'

const initial: AppState = useStore.getState()

export function resetStore(): void {
  useStore.setState(initial, true)
}
