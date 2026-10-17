// Render a component the way the app runs it: subscribed to main through `window.skyhawk`, with main
// in the state a Scenario describes. See skyhawk-mock.ts for why scenarios go in at the push level.
import type { ReactElement } from 'react'
import { act, render, type RenderResult } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { onTestFinished, vi } from 'vitest'
import { initBridge } from '../src/app/ipc-adapter'
import { skyhawk, type Scenario, type SkyhawkMock } from './skyhawk-mock'

/** Let pending IPC answers (the renderer's pulls) land. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

/**
 * Main is in `scenario` when the renderer loads: the renderer subscribes (what `App` does on
 * mount), its pulls answer from the scenario, then main pushes it. Either way the store ends up
 * holding what main pushed. Unsubscribes when the test ends, so the next test can subscribe again.
 */
async function startBridge(scenario: Scenario = {}): Promise<SkyhawkMock> {
  const sky = skyhawk()
  sky.emitScenario(scenario) // nobody subscribed yet: main's state as the renderer loads
  const off = initBridge()
  if (off) onTestFinished(off)
  await settle()
  sky.emitScenario(scenario)
  return sky
}

/**
 * `startBridge(scenario)`, then render `ui`. `user` drives it like a person would; under fake
 * timers its delays run on the fake clock.
 */
export async function renderScenario(
  ui: ReactElement,
  scenario: Scenario = {}
): Promise<RenderResult & { sky: SkyhawkMock; user: UserEvent }> {
  const sky = await startBridge(scenario)
  const user = userEvent.setup(
    vi.isFakeTimers() ? { advanceTimers: (ms) => vi.advanceTimersByTime(ms) } : {}
  )
  const result = render(ui)
  await settle()
  return { ...result, sky, user }
}
