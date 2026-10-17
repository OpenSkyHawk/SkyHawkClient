// T25 — the HID tab: live axes, hats and buttons, report freshness, calibration badges and offers.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { HidSnapshot } from '@shared/hid'
import { HidTab as Hid } from '../src/app/hid/HidTab'
import { renderScenario } from './render'
import { calCache, calDevice, calSnapshot, connected, link } from './scenarios'

/** What HIDControls.h catalogues: Roll, Pitch, Throttle; hat 0; buttons 0–3. */
const catalogue = { axes: [0, 1, 2], hats: [0], buttons: [0, 1, 2, 3] }

/** One HID report: Roll and Rudder off centre, hat 0 east, buttons 0 and 2 down, 25 Hz. */
const report = (over: Partial<HidSnapshot> = {}): HidSnapshot => ({
  axes: [1200, -32768, 0, 500, 0, 0, 0, 0],
  buttons: Array.from({ length: 128 }, (_, i) => i === 0 || i === 2),
  hats: [3, 0, 0, 0],
  ageMs: 100,
  rateHz: 25,
  ...over
})

/** An axis row's whole text, from its label: label, value, badge. */
const axis = (label: string) => screen.getByText(label).parentElement!.textContent
/** A hat's whole text, from its label. */
const hat = (n: number) => screen.getByText(`HAT ${n}`).parentElement!.textContent
/** The Reports card's freshness label and rate. */
const reports = () => screen.getByText('Reports').parentElement!.textContent

describe('T25 HID tab (B80)', () => {
  it('axes, hats and buttons from the latest report; uncatalogued indices dim to a dash', async () => {
    await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: catalogue,
      hid: report()
    })
    expect(axis('Roll')).toBe('Roll1200')
    expect(axis('Pitch')).toBe('Pitch-32768')
    expect(axis('Throttle')).toBe('Throttle0')
    // Rudder reports 500, but HIDControls.h has no Rudder slot this build lists.
    expect(axis('Rudder')).toBe('Rudder—')
    expect(screen.getByText('int16 · ±32768')).toBeInTheDocument()
    expect(hat(0)).toBe('HAT 0E')
    expect(hat(1)).toBe('HAT 1n/a')
    expect(screen.getByText(/4 mapped/).parentElement).toHaveTextContent(
      '128 × 1-bit · 4 mapped · 2 lit'
    )
    expect(reports()).toBe('Reportslive25 Hz')
  })

  it('freshness: live, idle, quiet by age while the board is there; "no link" only when it isn’t', async () => {
    const { sky } = await renderScenario(<Hid />, { device: connected(), hid: report() })
    expect(reports()).toBe('Reportslive25 Hz')
    sky.emitScenario({ hid: report({ ageMs: 2 * 60_000, rateHz: 0 }) })
    expect(reports()).toBe('Reportsidle0 Hz')
    sky.emitScenario({ hid: report({ ageMs: 10 * 60_000, rateHz: 0 }) })
    expect(reports()).toBe('Reportsquiet0 Hz')
    // The port released (Disconnect): the joystick still works, so it is not "no link" (#74).
    sky.emitScenario({ device: link('disconnected'), hid: report() })
    expect(reports()).toBe('Reportslive25 Hz')
    sky.emitScenario({ device: link('no-device') })
    expect(reports()).toBe('Reportsno link25 Hz')
  })

  it('calibration badges come from what the device reports; the header counts what is left', async () => {
    await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: catalogue,
      hid: report(),
      calDevice: calDevice(calSnapshot([{ idx: 0, calibrated: true }, { idx: 1 }]))
    })
    expect(axis('Roll')).toBe('Roll1200CAL')
    expect(axis('Pitch')).toBe('Pitch-32768RAW')
    // Catalogued, but this Gateway's sketch doesn't declare it.
    expect(axis('Throttle')).toBe('Throttle—')
    expect(screen.getByText('2 of 8 slots · device-reported')).toBeInTheDocument()
    expect(screen.getByText('1 axis uncalibrated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CAL' })).toHaveAttribute(
      'title',
      'Calibrate this axis'
    )
    expect(screen.getByRole('button', { name: 'Calibrate' })).toBeEnabled()
  })

  it('Calibrate is greyed out while the serial link is down, and says why', async () => {
    await renderScenario(<Hid />, {
      device: link('no-device'),
      hidAvailability: catalogue,
      hid: report(),
      calDevice: calDevice(calSnapshot([{ idx: 0, calibrated: true }]))
    })
    const calibrate = screen.getByRole('button', { name: 'Calibrate' })
    expect(calibrate).toBeDisabled()
    expect(calibrate).toHaveAttribute(
      'title',
      'Calibration needs the serial link — Connect on the Connection tab'
    )
    expect(screen.getByText('Calibration needs the serial link')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect on the Connection tab' })).toBeEnabled()
    // No snapshot without the link: no badges, and the live view still reads the joystick.
    expect(axis('Roll')).toBe('Roll1200')
  })

  it('offers "Review & restore" when the device lost an axis this client holds a confirmed copy of', async () => {
    const { user } = await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: catalogue,
      hid: report(),
      calDevice: calDevice(calSnapshot([{ idx: 0, calibrated: true }, { idx: 1 }]), {
        cache: calCache({ 1: { min: 12_000, centre: 33_000, max: 52_000, selfCentring: true } })
      })
    })
    expect(
      await screen.findByText(
        /^Pitch has no calibration on the device, but this client holds a copy the device confirmed on .+\.$/
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review & restore…' }))
    expect(await screen.findByText('Restore calibration to the device')).toBeInTheDocument()
    expect(screen.getByText('Axis Calibration · Pitch')).toBeInTheDocument()
  })

  it('no offer when the device still holds every cached axis, and none while the link is down', async () => {
    const pitch = { min: 12_000, centre: 33_000, max: 52_000, selfCentring: true }
    const held = await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: catalogue,
      calDevice: calDevice(calSnapshot([{ idx: 1, calibrated: true }]), {
        cache: calCache({ 1: pitch })
      })
    })
    expect(screen.getByText('all axes calibrated')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review & restore…' })).toBeNull()
    held.unmount()

    const { sky } = await renderScenario(<Hid />, {
      device: connected(),
      hidAvailability: catalogue,
      calDevice: calDevice(calSnapshot([{ idx: 1 }]), { cache: calCache({ 1: pitch }) })
    })
    expect(await screen.findByRole('button', { name: 'Review & restore…' })).toBeInTheDocument()
    sky.emitScenario({ device: link('no-device') })
    expect(screen.queryByRole('button', { name: 'Review & restore…' })).toBeNull()
  })
})
