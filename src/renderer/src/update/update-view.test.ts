// #187: the update dialog's words for the Gateway's cockpit side — its node-0 path as the design
// draws it: the bundle, a retry from *not responding*, the run's notes, each failure's footer.
import { describe, expect, it } from 'vitest'
import type { UpdateState, UpdateStep } from '@shared/update'
import { updateView } from './update-view'

const steps = (on: number, pct?: number): UpdateStep[] =>
  (['boot', 'write', 'verify', 'restart', 'ver'] as const).map((key, n) => ({
    key,
    state: n < on ? 'done' : n === on ? 'on' : 'waiting',
    ...(key === 'write' && n === on && pct !== undefined && { pct })
  }))

const COCKPIT: UpdateState = {
  target: { kind: 'cockpit' },
  name: 'Gateway · cockpit side',
  from: '1.0.0',
  bundle: true,
  to: '1.0.1',
  phase: 'confirm',
  checks: [
    { kind: 'relay', ok: true },
    { kind: 'link', ok: true },
    { kind: 'uploader', ok: true },
    { kind: 'calibration', ok: true },
    { kind: 'image', ok: true, version: '1.0.1', bundle: true }
  ],
  ack: false,
  canStart: true,
  estimateSec: 5,
  steps: steps(-1),
  pct: 0,
  relayRunning: false
}

describe('update dialog words: the Gateway cockpit side (#187)', () => {
  it('the confirm: carried by the USB side, its checks, the whole cockpit pauses, about 5 s', () => {
    const v = updateView(COCKPIT)
    expect(v.title).toBe('Update Gateway · cockpit side')
    expect(v.sub).toBe('1.0.0 → 1.0.1 · carried by the USB side')
    // The uploader is listed only when it is missing.
    expect(v.checks.map((c) => c.text)).toEqual([
      'DCS relay stopped',
      'Gateway connected',
      'No calibration session open',
      'Carried by the Gateway’s firmware'
    ])
    expect(v.note).toEqual({
      title: 'The whole cockpit pauses',
      text: 'every board’s input goes through the Gateway’s cockpit side. About 5 s; the boards’ warning LEDs light briefly.'
    })
    expect(v.foot).toBe('about 5 s')
    expect(v.startLabel).toBe('Update to 1.0.1')
  })

  it('a retry reads the state, not a version; a staged image shows its size and checks', () => {
    const v = updateView({
      ...COCKPIT,
      from: undefined,
      fromState: 'not-responding',
      bundle: undefined,
      sizeKb: 34,
      checks: [
        { kind: 'relay', ok: true },
        { kind: 'link', ok: true },
        { kind: 'uploader', ok: false },
        { kind: 'calibration', ok: false },
        { kind: 'image', ok: true, version: '1.0.1' },
        { kind: 'built-for', ok: true, nodeId: 0 },
        { kind: 'fits', ok: true, maxKb: 124 }
      ]
    })
    expect(v.sub).toBe('not responding → 1.0.1 · firmware 1.0.1')
    expect(v.board).toMatchObject({ chip: 'NOT RESPONDING', chipCls: 'vchip--err' })
    expect(v.startLabel).toBe('Retry the update')
    expect(v.foot).toBe('34 KB · about 5 s')
    expect(v.checks.slice(2)).toEqual([
      {
        ok: false,
        text: 'The Gateway’s USB side needs newer firmware to update its cockpit side — update the USB side first.',
        fix: 'usb-first'
      },
      { ok: false, text: 'A calibration session is open — finish or cancel it first.' },
      { ok: true, text: 'Firmware 1.0.1 · saved on this computer, checked' },
      { ok: true, text: 'Built for #0 · Gateway · cockpit side — matches this board' },
      {
        ok: true,
        text: 'Fits the 124 KB limit; the board checks its own flash before anything is erased'
      }
    ])
  })

  it('the run: its note above the steps, Writing · n%, and the cut-off foot', () => {
    const v = updateView({
      ...COCKPIT,
      phase: 'run',
      steps: steps(1, 42),
      note: { kind: 'retrying', n: 1, of: 2 }
    })
    expect(v.runNote).toEqual({
      cls: 'sh__fault--warn',
      title: 'Write interrupted',
      text: 'retrying automatically (1 of 2).'
    })
    expect(v.steps.map((s) => s.label)).toEqual([
      'Entering its bootloader',
      'Writing · 42%',
      'Verifying',
      'Restarting',
      'Confirming the version it reports'
    ])
    expect(v.foot).toBe(
      'Don’t unplug the Gateway. Closing the client is fine — the Gateway finishes on its own.'
    )
    const cut = updateView({ ...COCKPIT, phase: 'run', steps: steps(1), note: { kind: 'cut-off' } })
    expect(cut.foot).toBe(
      'The client can’t reach the Gateway — it finishes this board by itself. You can close this; the Firmware sheet shows what it runs once it’s back.'
    )
    expect(cut.canClose).toBe(false)
    expect(updateView({ ...COCKPIT, phase: 'run', steps: steps(1), closable: true }).canClose).toBe(
      true
    )
    expect(
      updateView({ ...COCKPIT, phase: 'run', steps: steps(0), note: { kind: 'press-reset' } })
        .runNote?.title
    ).toBe('Press the reset button on the Gateway board')
  })

  it('failures: the instruction with nothing written; the bootloader footer after the erase', () => {
    const fail = (f: UpdateState['failure'], after?: UpdateState['after']) =>
      updateView({
        ...COCKPIT,
        phase: 'fail',
        steps: steps(1),
        failure: f,
        ...(after && { after })
      })
    expect(fail({ kind: 'no-response' }, 'refused')).toMatchObject({
      fail: {
        title: 'No response',
        text: 'press the reset button on the Gateway board. If nothing happens within a few seconds, press it again. Check the cockpit is powered.'
      },
      foot: 'Nothing was written.'
    })
    expect(fail({ kind: 'write-failed' }, 'erased')).toMatchObject({
      fail: { title: 'Stuck in its bootloader' },
      foot: 'Nothing else changed. The cockpit side waits in its bootloader; Retry finishes it.'
    })
    expect(fail({ kind: 'refused', why: 'wrong-kind' }, 'refused').foot).toBe(
      'Nothing was written. The board goes back to its old firmware within 30 s.'
    )
    expect(fail({ kind: 'no-confirmation' })).toMatchObject({
      fail: { text: 'it didn’t report its new version after the update.' },
      foot: 'Check its version on the Firmware sheet.'
    })
    expect(fail({ kind: 'not-responding' }, 'erased').fail?.text).toBe(
      'the Gateway lost power while its cockpit side was updating, and the cockpit side doesn’t answer now. Retry the update.'
    )
  })
})
