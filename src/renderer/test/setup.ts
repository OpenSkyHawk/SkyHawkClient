// Setup for the jsdom project (`*.test.tsx`): jest-dom matchers, a fresh store and a fresh
// `window.skyhawk` mock before every test, and the DOM torn down after it.
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { installSkyhawkMock } from './skyhawk-mock'
import { resetStore } from './store-reset'

// jsdom has no layout: components that measure (the Cockpit plan, BoardEvents) need a
// ResizeObserver to exist. It never fires; jsdom reports every size as 0.
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoResizeObserver

// Testing Library drains each user-event call with a setTimeout(0), and advances it only when it
// sees Jest's fake timers. Under `vi.useFakeTimers()` that timeout never fires and the call hangs;
// this shim lets it advance Vitest's fake clock instead. Real timers are unaffected.
;(globalThis as { jest?: unknown }).jest ??= {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms)
}

beforeEach(() => {
  resetStore()
  installSkyhawkMock()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
