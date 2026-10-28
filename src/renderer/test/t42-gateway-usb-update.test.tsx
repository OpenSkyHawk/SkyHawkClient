// T42 — the firmware update dialog for the Gateway's USB side (#173): the row's Update, the confirm
// step's checks and notes, the run, every failure with Close · Retry, and the result with its
// calibration note and the relay hint — as main pushes each state (`update:state`).
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { RELEASES_STATE_DEFAULT } from '@shared/releases'
import type { NodeStatus } from '@shared/nodes'
import type { UpdateState, UpdateStep } from '@shared/update'
import { App } from '../src/app/App'
import { useNav } from '../src/app/kit'
import { renderScenario, settle } from './render'
import { skyhawk } from './skyhawk-mock'
import { connected, gateway, model, savedRelease } from './scenarios'

const steps = (states: UpdateStep['state'][], pct?: number): UpdateStep[] =>
  (['uf2', 'copy', 'rec', 'ver'] as const).map((key, n) => ({
    key,
    state: states[n]!,
    ...(key === 'copy' && pct !== undefined && { pct })
  }))

const CONFIRM: UpdateState = {
  target: { kind: 'usb' },
  name: 'Gateway · USB side',
  from: '1.0.0',
  to: '1.0.1',
  phase: 'confirm',
  checks: [
    { kind: 'relay', ok: true },
    { kind: 'link', ok: true },
    { kind: 'image', ok: true, version: '1.0.1' }
  ],
  ack: false,
  canStart: true,
  estimateSec: 5,
  steps: steps(['waiting', 'waiting', 'waiting', 'waiting']),
  pct: 0,
  relayRunning: false
}

const at = (patch: Partial<UpdateState>): UpdateState => ({ ...CONFIRM, ...patch })

async function open(update: UpdateState | null, extra: Parameters<typeof renderScenario>[1] = {}) {
  const r = await renderScenario(<App />, { device: connected(), update, ...extra })
  const dialog = () => screen.getByRole('dialog', { name: 'Firmware update' })
  return { ...r, dialog }
}

describe('T42 the Gateway USB side’s update (#173)', () => {
  it('the sheet row’s Update opens the dialog in main', async () => {
    const fw = (v: string): Partial<NodeStatus> => {
      const [fwMajor, fwMinor, fwPatch] = v.split('.').map(Number)
      return { fwMajor, fwMinor, fwPatch, bootloader: 1 }
    }
    const { user } = await renderScenario(<App />, {
      device: connected(gateway(fw('1.0.1'))),
      model: model([]),
      releases: RELEASES_STATE_DEFAULT,
      firmware: { usb: { major: 1, minor: 0, patch: 0 }, release: savedRelease('1.0.1') }
    })
    useNav.getState().set({ tab: 'cockpit' })
    await settle()
    await user.click(screen.getByRole('button', { name: /^Firmware/ }))
    await user.click(screen.getByRole('button', { name: 'Update' }))
    expect(skyhawk().updateOpen).toHaveBeenCalledWith({ kind: 'usb' })
  })

  it('confirm, as drawn: the board, the checks, the Gateway note, about 5 s, Update to 1.0.1', async () => {
    const { user, dialog } = await open(CONFIRM)
    const d = dialog()
    expect(within(d).getByText('Update Gateway · USB side')).toBeInTheDocument()
    expect(within(d).getByText('1.0.0 → 1.0.1 · firmware 1.0.1')).toBeInTheDocument()
    expect(within(d).getByRole('list', { name: 'Board' })).toHaveTextContent(
      '1Gateway · USB side1.0.0 → 1.0.1UPDATE AVAILABLE'
    )
    expect(within(d).getByLabelText('Checks')).toHaveTextContent(
      '✓DCS relay stopped✓Gateway connected✓Firmware 1.0.1 · saved on this computer, checked'
    )
    expect(
      within(d).getByText(
        /it restarts to update and reconnects by itself\. Keep it plugged in\. If the update clears its axis calibration, this computer’s copy is restored automatically\./
      )
    ).toBeInTheDocument()
    expect(within(d).getByText('about 5 s')).toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: 'Update to 1.0.1' }))
    expect(skyhawk().updateStart).toHaveBeenCalledTimes(1)
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    expect(skyhawk().updateClose).toHaveBeenCalledTimes(1)
  })

  it('blocked: the relay running (Stop relay), no Gateway, the release not saved (Check for updates)', async () => {
    const { user, dialog } = await open(
      at({
        canStart: false,
        relayRunning: true,
        checks: [
          { kind: 'relay', ok: false },
          { kind: 'link', ok: false },
          { kind: 'image', ok: false, version: '1.0.1' }
        ]
      }),
      { relay: { running: true } }
    )
    const d = dialog()
    expect(within(d).getByLabelText('Checks')).toHaveTextContent(
      '✕The DCS relay is running — updates need the sim idle.Stop relay✕The Gateway isn’t connected — connect it first.✕Firmware 1.0.1 isn’t on this computer.Check for updates'
    )
    expect(within(d).getByRole('button', { name: 'Update to 1.0.1' })).toBeDisabled()
    await user.click(within(d).getByRole('button', { name: 'Stop relay' }))
    expect(skyhawk().stopRelay).toHaveBeenCalled()
    await user.click(within(d).getByRole('button', { name: 'Check for updates' }))
    expect(skyhawk().checkReleases).toHaveBeenCalledTimes(1)
  })

  it('the Gateway waiting in its update drive: its own sub, chip, check and note; the steps from the copy', async () => {
    const IN_DRIVE = at({
      from: undefined,
      inDrive: true,
      checks: [
        { kind: 'relay', ok: true },
        { kind: 'drive', ok: true },
        { kind: 'image', ok: true, version: '1.0.1' }
      ],
      steps: steps(['waiting', 'waiting', 'waiting', 'waiting']).slice(1)
    })
    const { dialog, sky } = await open(IN_DRIVE)
    let d = dialog()
    expect(within(d).getByText('in its update drive → 1.0.1 · firmware 1.0.1')).toBeInTheDocument()
    expect(within(d).getByRole('list', { name: 'Board' })).toHaveTextContent(
      '1Gateway · USB sidein its update drive → 1.0.1IN UPDATE DRIVE'
    )
    expect(within(d).getByLabelText('Checks')).toHaveTextContent(
      '✓DCS relay stopped✓Gateway waiting in its update drive✓Firmware 1.0.1 · saved on this computer, checked'
    )
    expect(
      within(d).getByText(
        /it restarts by itself once the copy lands, and reconnects\. Keep it plugged in\./
      )
    ).toBeInTheDocument()
    // Another RP2040 in BOOTSEL too: blocked, no guessing.
    sky.emitScenario({
      update: {
        ...IN_DRIVE,
        canStart: false,
        checks: [
          IN_DRIVE.checks[0]!,
          { kind: 'drive', ok: false, problem: 'many' },
          IN_DRIVE.checks[2]!
        ]
      }
    })
    await settle()
    d = dialog()
    expect(within(d).getByLabelText('Checks')).toHaveTextContent(
      '✕More than one update drive is mounted — unplug the other RP2040 board.'
    )
    expect(within(d).getByRole('button', { name: 'Update to 1.0.1' })).toBeDisabled()
    // The Gateway left its drive (running again, or unplugged): it says so, not "unplug".
    sky.emitScenario({
      update: {
        ...IN_DRIVE,
        canStart: false,
        checks: [
          IN_DRIVE.checks[0]!,
          { kind: 'drive', ok: false, problem: 'none' },
          IN_DRIVE.checks[2]!
        ]
      }
    })
    await settle()
    expect(within(dialog()).getByLabelText('Checks')).toHaveTextContent(
      '✕The Gateway left its update drive — close and update it from its row.'
    )
    // The run starts at the copy.
    sky.emitScenario({
      update: {
        ...IN_DRIVE,
        phase: 'run',
        steps: steps(['done', 'on', 'waiting', 'waiting'], 10).slice(1)
      }
    })
    await settle()
    expect(within(dialog()).getByLabelText('Steps')).toHaveTextContent(
      '›Copying the firmware · 10%·Reconnecting·Confirming the version it reports'
    )
  })

  it('halves on different majors: the warning row and I understand', async () => {
    const { user, dialog } = await open(at({ halves: { usb: 1, cockpit: 0 }, canStart: false }))
    const d = dialog()
    expect(
      within(d).getByText(
        /its USB side would be on 1\.x and its cockpit side on 0\.x\. Update both halves together\./
      )
    ).toBeInTheDocument()
    expect(within(d).getByText('Gateway halves differ')).toBeInTheDocument()
    expect(
      within(d).getByText(
        'I understand these boards won’t work together until they share a major version.'
      )
    ).toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: 'I understand' }))
    expect(skyhawk().updateAck).toHaveBeenCalledWith(true)
  })

  it('running: the steps with the copy’s percent, the bar, the footer; no Close', async () => {
    const { dialog } = await open(
      at({ phase: 'run', steps: steps(['done', 'on', 'waiting', 'waiting'], 40), pct: 35 })
    )
    const d = dialog()
    expect(within(d).getByText('Updating Gateway · USB side')).toBeInTheDocument()
    expect(within(d).getByLabelText('Steps')).toHaveTextContent(
      '✓Restarting the Gateway to update it›Copying the firmware · 40%·Reconnecting·Confirming the version it reports'
    )
    expect(within(d).getByRole('img', { name: '35% of this board' })).toBeInTheDocument()
    expect(
      within(d).getByText('Keep the Gateway plugged in — it restarts and reconnects by itself.')
    ).toBeInTheDocument()
    expect(within(d).queryByRole('button', { name: /^(Close|Cancel)$/ })).toBeNull()
  })

  it.each<[UpdateState['failure'], string, string]>([
    [
      { kind: 'no-drive' },
      'No Gateway drive appeared — hold BOOTSEL while plugging the Gateway in, then Retry. Nothing has been written yet.',
      'Nothing was written.'
    ],
    [
      { kind: 'copy-failed' },
      'Copy failed — the Gateway’s drive went away during the copy. Retry copies the whole file again; if the Gateway doesn’t come back, hold BOOTSEL while plugging it in.',
      'The Gateway waits in its update drive until a copy goes through.'
    ],
    [
      { kind: 'many-drives' },
      'More than one update drive — another RP2040 board is waiting in its update drive too. Unplug it, then Retry.',
      'Nothing was written.'
    ],
    [
      { kind: 'left-drive' },
      'Not in its update drive — the Gateway is running again, so there is nothing to copy to. Close, and update it from its row.',
      'Nothing was written.'
    ],
    [
      { kind: 'no-reconnect' },
      'Didn’t reconnect — the Gateway didn’t come back after the copy. Retry looks for it again.',
      'The copy finished. The client keeps looking for the Gateway.'
    ],
    [
      { kind: 'wrong-version', reported: '1.0.0' },
      'Wrong version — it reports 1.0.0, not 1.0.1. Nothing is retried automatically.',
      'It runs the version it reports.'
    ],
    [
      {
        kind: 'image',
        message: 'The saved copy of firmware 1.0.1 is damaged and couldn’t be downloaded again.'
      },
      'Firmware not available — the saved copy of firmware 1.0.1 is damaged and couldn’t be downloaded again.',
      'Nothing was written.'
    ]
  ])('failed (%o): the text, the footer, Close · Retry only', async (failure, text, foot) => {
    const { user, dialog } = await open(
      at({ phase: 'fail', failure, steps: steps(['bad', 'waiting', 'waiting', 'waiting']) })
    )
    const d = dialog()
    expect(within(d).getByText('Gateway · USB side didn’t update')).toBeInTheDocument()
    expect(within(d).getByRole('alert')).toHaveTextContent(text)
    expect(within(d).getByText(foot)).toBeInTheDocument()
    const buttons = within(d)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(buttons).toEqual(['Close', 'Close', 'Retry'])
    await user.click(within(d).getByRole('button', { name: 'Retry' }))
    expect(skyhawk().updateRetry).toHaveBeenCalledTimes(1)
  })

  it.each<[UpdateState['done'], string, string | undefined]>([
    [{ reports: '1.0.1' }, 'now 1.0.1', undefined],
    [
      { reports: '1.0.1', calibration: 'restored' },
      'now 1.0.1 · axis calibration restored',
      'Axis calibration restored from this computer’s copy.'
    ],
    [
      { reports: '1.0.1', calibration: 'cleared-no-copy' },
      'now 1.0.1',
      'Axis calibration was cleared and this computer has no saved copy — calibrate it on the HID page (Device I/O › HID).'
    ],
    [
      { reports: '1.0.1', calibration: 'restore-failed' },
      'now 1.0.1',
      'Axis calibration was cleared and restoring this computer’s copy failed — calibrate it on the HID page (Device I/O › HID).'
    ]
  ])('done (%o): reports, the calibration note, the relay hint', async (done, sub, note) => {
    const { user, dialog } = await open(
      at({ phase: 'done', done, pct: 100, steps: steps(['done', 'done', 'done', 'done']) })
    )
    const d = dialog()
    expect(within(d).getByText('Update finished')).toBeInTheDocument()
    expect(within(d).getByText('Gateway · USB side reports 1.0.1')).toBeInTheDocument()
    expect(within(d).getByRole('list', { name: 'Result' })).toHaveTextContent(
      `✓Gateway · USB side${sub}`
    )
    if (note) expect(within(d).getByText(note)).toBeInTheDocument()
    expect(
      within(d).getByText(
        'The relay stays stopped. Start it from the pill when you’re ready to fly.'
      )
    ).toBeInTheDocument()
    expect(
      within(d).getByText('Each version is the one the board itself reports.')
    ).toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: 'Done' }))
    expect(skyhawk().updateClose).toHaveBeenCalled()
  })

  it('nothing open: no dialog; main’s push opens it over any tab', async () => {
    const { sky } = await open(null)
    expect(screen.queryByRole('dialog', { name: 'Firmware update' })).toBeNull()
    sky.emitScenario({ update: CONFIRM })
    await settle()
    expect(screen.getByRole('dialog', { name: 'Firmware update' })).toBeInTheDocument()
  })
})
