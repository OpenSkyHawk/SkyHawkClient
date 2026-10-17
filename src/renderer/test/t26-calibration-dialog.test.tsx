// T26 — the axis calibration dialog, opened from the HID tab and driven by the device's answers.
//
// Nothing in the renderer is stubbed: the dialog's own controller talks to the mock's scripted
// Gateway (CalDevice: SESSION_OPEN / STREAM_SELECT / COMMIT / GET_CAL answers and the restore
// cache), and the axis moves by RAW batches on `cal:raw`, the way main forwards them.
import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import type { CalDevice } from './skyhawk-mock'
import { HidTab as Hid } from '../src/app/hid/HidTab'
import { renderScenario } from './render'
import { calCache, calDevice, calSnapshot, connected, link, sweeps } from './scenarios'

const T0 = new Date(2026, 9, 16, 21, 0, 0).getTime()
const PAUSED =
  'Serial link closed — calibration is paused; nothing more reaches the device. Connect on the Connection tab to continue (captured sweeps are kept).'

/** Roll (axis 0) calibrated 10000 … 32768 … 55000; Pitch (axis 1) declared, not calibrated. */
const gatewayWith = (over: Partial<CalDevice> = {}) =>
  calDevice(calSnapshot([{ idx: 0, calibrated: true }, { idx: 1 }]), over)

/** The dialog sheet (it has no dialog role today), from its title. */
const sheet = () => screen.getByText(/^Axis Calibration · /).closest('header')!.parentElement!
const inSheet = () => within(sheet())
const button = (name: string | RegExp) => inSheet().getByRole('button', { name })
/** The header's link line: `Gateway · connected · signed ±32767`. */
const linkLine = () => inSheet().getByText(/^Gateway ·/).textContent
/** The paused notice's whole text; undefined when it isn't shown. */
const pausedNote = () => inSheet().queryByText('Serial link closed')?.parentElement?.textContent
/** The rail's axis button for `label`: its name, slot, unwritten-work dot and badge. */
const axisButton = (label: string) => button(new RegExp(`^${label}`))

/** The HID tab on a calibration-capable Gateway, and Calibrate clicked. */
async function openDialog(device = gatewayWith()) {
  const r = await renderScenario(<Hid />, {
    device: connected(),
    hidAvailability: { axes: [0, 1, 2], hats: [], buttons: [] },
    calDevice: device
  })
  await r.user.click(screen.getByRole('button', { name: 'Calibrate' }))
  await screen.findByText('Axis Calibration · Pitch')
  return r
}

/** Advance the fake clock and let the device's answers land. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

describe('T26 CalibrationDialog (B83, B82)', () => {
  it('opens a session on the first uncalibrated axis; Write is greyed out with nothing captured', async () => {
    const { sky, user } = await openDialog()
    expect(sky.calSessionOpen).toHaveBeenCalledWith(1)
    expect(linkLine()).toBe('Gateway · connected · signed ±32767')
    expect(axisButton('Roll')).toHaveTextContent('RollAxis 0CAL')
    expect(axisButton('Pitch')).toHaveTextContent('PitchAxis 1RAW')
    expect(
      inSheet().getByText(
        '2 of 8 slots · device-reported. Edits are kept when you switch axes and written together.'
      )
    ).toBeInTheDocument()
    expect(button('Write')).toBeDisabled()
    expect(button('Start travel capture')).toBeEnabled()
    expect(inSheet().queryByRole('button', { name: 'Delete calibration' })).toBeNull()

    // Roll: the stored calibration, Re-capture and Delete.
    await user.click(axisButton('Roll'))
    expect(await inSheet().findByText('Axis Calibration · Roll')).toBeInTheDocument()
    expect(sky.calStreamSelect).toHaveBeenCalledWith(0)
    expect(button('Re-capture travel')).toBeEnabled()
    expect(button('Delete calibration')).toBeEnabled()
    expect(inSheet().getByText('Recorded travel').parentElement).toHaveTextContent(
      'Recorded travel69%45,000 countsGood'
    )

    // Cancel closes the session and re-reads what the device holds.
    sky.calRead.mockClear()
    await user.click(button('Cancel'))
    expect(sky.calSessionClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/^Axis Calibration · /)).toBeNull()
    expect(sky.calRead).toHaveBeenCalled()
  })

  it('while capturing, the capture and rest-position buttons are greyed out', async () => {
    const { user } = await openDialog()
    await user.click(button('Start travel capture'))
    expect(button('Start travel capture')).toBeDisabled()
    expect(button('Self-centring')).toBeDisabled()
    expect(button('None')).toBeDisabled()
    expect(button('Write')).toBeDisabled()
    expect(inSheet().getByText('Sweep 1 of 3')).toBeInTheDocument()
    expect(inSheet().getByText('3 sweeps remaining')).toBeInTheDocument()
    expect(inSheet().getByText('Sweep the axis all the way to either stop')).toBeInTheDocument()
  })

  it('three sweeps make a draft; Write sends it, and everything is greyed out until the device confirms', async () => {
    vi.useFakeTimers({ now: T0 })
    const { sky, user } = await openDialog()
    await user.click(button('None'))
    expect(
      inSheet().getByText('No rest position — centre is the midpoint of the captured travel.')
    ).toBeInTheDocument()
    await user.click(button('Start travel capture'))
    sky.emitScenario({ calRaw: sweeps(1, Date.now(), 10_000, 55_000) })

    expect(inSheet().getByText('3 of 3 sweeps captured')).toBeInTheDocument()
    expect(
      inSheet().getByText('Captured, not written — nothing reaches the device until you write.')
    ).toBeInTheDocument()
    expect(axisButton('Pitch')).toHaveTextContent('PitchAxis 1●RAW')
    expect(button('Write 1 axis')).toBeEnabled()

    await user.click(button('Write 1 axis'))
    expect(sky.calCommit).toHaveBeenCalledWith({ idx: 1, min: 10_000, centre: 32_500, max: 55_000 })
    expect(inSheet().getByText('Writing Pitch to the device…')).toBeInTheDocument()
    expect(button('Writing…')).toBeDisabled()
    expect(button('Cancel')).toBeDisabled()
    expect(button('✕')).toBeDisabled()
    expect(axisButton('Roll')).toBeDisabled()
    expect(button('Re-capture travel')).toBeDisabled()

    await wait(700)
    expect(inSheet().getByText('Reading Pitch back from the device…')).toBeInTheDocument()
    await wait(700)
    expect(
      inSheet().getByText('Stored on the device — read back and confirmed.')
    ).toBeInTheDocument()
    expect(axisButton('Pitch')).toHaveTextContent('PitchAxis 1CAL')
    expect(button('Write')).toBeDisabled()
    expect(button('Cancel')).toBeEnabled()
    expect(sky.calCacheStore).toHaveBeenCalledWith([
      { idx: 1, min: 10_000, centre: 32_500, max: 55_000, selfCentring: false }
    ])

    await wait(3000)
    expect(
      inSheet().getByText(
        'Pitch written to the device and read back. The axis now reports through this calibration.'
      )
    ).toBeInTheDocument()
  })

  it('a draft the device would refuse names the axis and keeps Write greyed out', async () => {
    const { sky, user } = await openDialog()
    // Self-centring (the default), and the axis comes to rest past its upper stop.
    await user.click(button('Start travel capture'))
    sky.emitScenario({ calRaw: sweeps(1, Date.now(), 10_000, 55_000, 3, 60_000) })
    expect(inSheet().getByText('Pitch: centre must fall between min and max')).toBeInTheDocument()
    expect(button('Write 1 axis')).toBeDisabled()
  })

  it('the link drops: paused, nothing can be sent, drafts kept; it resumes when the board reports', async () => {
    const { sky, user } = await openDialog()
    await user.click(button('None'))
    await user.click(button('Start travel capture'))
    sky.emitScenario({ calRaw: sweeps(1, Date.now(), 10_000, 55_000) })
    expect(button('Write 1 axis')).toBeEnabled()

    sky.emitScenario({ device: link('reconnecting') })
    expect(linkLine()).toBe('Gateway · serial link closed · signed ±32767')
    expect(pausedNote()).toBe(PAUSED)
    expect(button('Write 1 axis')).toBeDisabled()
    expect(button('Re-capture travel')).toBeDisabled()
    expect(axisButton('Pitch')).toHaveTextContent('PitchAxis 1●RAW')

    // Axes still switch, locally: nothing goes to the device while paused.
    await user.click(axisButton('Roll'))
    expect(inSheet().getByText('Axis Calibration · Roll')).toBeInTheDocument()
    expect(sky.calStreamSelect).not.toHaveBeenCalled()
    expect(button('Delete calibration')).toBeDisabled()

    // The same board reports again: the session reopens on the axis on screen.
    sky.emitScenario({ device: connected() })
    expect(await inSheet().findByText('connected')).toBeInTheDocument()
    expect(linkLine()).toBe('Gateway · connected · signed ±32767')
    expect(sky.calSessionOpen).toHaveBeenLastCalledWith(0)
    expect(sky.calSessionOpen).toHaveBeenCalledTimes(2)
    expect(pausedNote()).toBeUndefined()
    expect(button('Write 1 axis')).toBeEnabled()
    expect(button('Delete calibration')).toBeEnabled()
  })

  it('a sweep interrupted by the link is started again on resume; accepted sweeps are kept', async () => {
    const { sky, user } = await openDialog()
    await user.click(button('None'))
    await user.click(button('Start travel capture'))
    sky.emitScenario({ calRaw: sweeps(1, Date.now(), 10_000, 55_000, 1) })
    expect(inSheet().getByText('2 sweeps remaining')).toBeInTheDocument()
    expect(inSheet().getByText('Sweep 2 of 3')).toBeInTheDocument()

    sky.emitScenario({ device: link('reconnecting') })
    // A paused capture asks for no movement.
    expect(inSheet().queryByText('Sweep the axis all the way to either stop')).toBeNull()
    expect(button('Start travel capture')).toBeDisabled()

    sky.emitScenario({ device: connected() })
    expect(
      await inSheet().findByText('Sweep the axis all the way to either stop')
    ).toBeInTheDocument()
    expect(inSheet().getByText('2 sweeps remaining')).toBeInTheDocument()
  })

  it('restore: the panel lists the cached copy; Not now folds it to a re-offer; Restore writes it', async () => {
    vi.useFakeTimers({ now: T0 })
    const cached = { min: 12_000, centre: 33_000, max: 52_000, selfCentring: true }
    const { sky, user } = await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: { axes: [0, 1], hats: [], buttons: [] },
      calDevice: gatewayWith({ cache: calCache({ 1: cached }) })
    })
    await user.click(await screen.findByRole('button', { name: 'Review & restore…' }))
    await screen.findByText('Axis Calibration · Pitch')
    expect(inSheet().getByText('Restore calibration to the device')).toBeInTheDocument()
    expect(inSheet().getByText(/^confirmed .+/)).toBeInTheDocument()
    expect(inSheet().getByText('centre measured').parentElement).toHaveTextContent(
      'Pitch-20,768 … 232 … 19,232centre measured'
    )
    expect(inSheet().getByText(/Only axes the device has lost are written/)).toHaveTextContent(
      'min / centre / max per axis, for board E6614103E7452D2F. Only axes the device has lost are written; anything it still holds is left alone.'
    )

    await user.click(button('Not now'))
    expect(inSheet().queryByText('Restore calibration to the device')).toBeNull()
    await user.click(button('1 axis has a saved copy this device no longer holds — review'))
    expect(inSheet().getByText('Restore calibration to the device')).toBeInTheDocument()

    await user.click(button('Restore 1 axis'))
    expect(sky.calCommit).toHaveBeenCalledWith({ idx: 1, min: 12_000, centre: 33_000, max: 52_000 })
    // Writing: the offer is out of the way.
    expect(inSheet().queryByText('Restore calibration to the device')).toBeNull()
    await wait(1400)
    expect(
      inSheet().getByText('Stored on the device — read back and confirmed.')
    ).toBeInTheDocument()
    // The device holds it now: nothing left to offer.
    await wait(3000)
    expect(
      inSheet().queryByRole('button', { name: /saved copy this device no longer holds/ })
    ).toBeNull()
    expect(inSheet().queryByText('Restore calibration to the device')).toBeNull()
    expect(axisButton('Pitch')).toHaveTextContent('PitchAxis 1CAL')
  })
})
