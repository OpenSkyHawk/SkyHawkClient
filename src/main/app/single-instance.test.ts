import { describe, expect, it } from 'vitest'
import {
  claimSingleInstance,
  type FocusableWindow,
  type SingleInstanceApp
} from './single-instance'

/** A fake `app` that records every call, and fires `second-instance` on demand. */
function fakeApp(lock: boolean) {
  const calls: string[] = []
  const listeners = new Map<string, () => void>()
  const app: SingleInstanceApp = {
    requestSingleInstanceLock: () => {
      calls.push('requestSingleInstanceLock')
      return lock
    },
    quit: () => calls.push('quit'),
    on: (event, listener) => {
      calls.push(`on ${event}`)
      listeners.set(event, listener)
    }
  }
  const secondLaunch = () => listeners.get('second-instance')?.()
  return { app, calls, secondLaunch }
}

function fakeWindow(minimized: boolean) {
  const calls: string[] = []
  const win: FocusableWindow = {
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus')
  }
  return { win, calls }
}

describe('claimSingleInstance (D4/M5)', () => {
  it('lock obtained: carries on, does not quit, and listens for a second launch', () => {
    const { app, calls } = fakeApp(true)
    const create = () => calls.push('create')
    expect(claimSingleInstance(app, () => null, create)).toBe(true)
    expect(calls).toEqual(['requestSingleInstanceLock', 'on second-instance'])
  })

  it('lock refused: quits and does nothing else', () => {
    const { app, calls } = fakeApp(false)
    let asked = false
    const window = () => {
      asked = true
      return null
    }
    const create = () => calls.push('create')
    expect(claimSingleInstance(app, window, create)).toBe(false)
    expect(calls).toEqual(['requestSingleInstanceLock', 'quit'])
    expect(asked).toBe(false)
  })

  it('second launch: restores the minimised window, then focuses it', () => {
    const { app, secondLaunch } = fakeApp(true)
    const { win, calls } = fakeWindow(true)
    claimSingleInstance(
      app,
      () => win,
      () => calls.push('create')
    )
    expect(calls).toEqual([]) // nothing happens until a second launch
    secondLaunch()
    expect(calls).toEqual(['restore', 'focus'])
  })

  it('second launch: focuses a window that is not minimised, without restoring it', () => {
    const { app, secondLaunch } = fakeApp(true)
    const { win, calls } = fakeWindow(false)
    claimSingleInstance(
      app,
      () => win,
      () => calls.push('create')
    )
    secondLaunch()
    expect(calls).toEqual(['focus'])
  })

  it('second launch with no window: creates one, as activate does, then focuses it', () => {
    const { app, secondLaunch } = fakeApp(true)
    const { win, calls } = fakeWindow(false)
    let current: FocusableWindow | null = null
    const create = () => {
      calls.push('create')
      current = win
    }
    claimSingleInstance(app, () => current, create)
    secondLaunch()
    expect(calls).toEqual(['create', 'focus'])
  })

  it('second launch: reads the window at that moment, and creates none when one is open', () => {
    const { app, secondLaunch } = fakeApp(true)
    let current: FocusableWindow | null = null
    let created = 0
    claimSingleInstance(
      app,
      () => current,
      () => created++
    )
    const { win, calls } = fakeWindow(false)
    current = win // created after the lock was taken, as in start()
    secondLaunch()
    expect(calls).toEqual(['focus'])
    expect(created).toBe(0)
  })
})
