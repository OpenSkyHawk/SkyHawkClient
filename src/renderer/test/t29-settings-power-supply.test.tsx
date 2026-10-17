// T29 — Settings › Cockpit › Power supply: the NX650 preset or limits typed by hand.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { PsuSetting } from '@shared/nodes'
import { Settings } from '../src/tabs/Settings'
import { renderScenario, settle } from './render'
import { connected } from './scenarios'

const LIMITS = ['12 V rail limit', '5 V rail limit', 'Total power'] as const

/** Settings on its Cockpit section, with `psu` saved. */
async function openPowerSupply(psu?: PsuSetting) {
  const r = await renderScenario(<Settings />, {
    device: connected(),
    ...(psu && { config: { psu } })
  })
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  const group = screen.getByRole('group', { name: 'Power supply' })
  const preset = within(group).getByRole('button', { name: 'NX650' })
  const custom = within(group).getByRole('button', { name: 'Custom' })
  const field = (l: (typeof LIMITS)[number]) => screen.getByRole('textbox', { name: l })
  const values = () => LIMITS.map((l) => (field(l) as HTMLInputElement).value)
  /** The psu setting of the last save sent to main. */
  const saved = () => r.sky.setConfig.mock.lastCall?.[0].psu
  return { ...r, preset, custom, field, values, saved }
}

describe('T29 Settings › Cockpit › Power supply (B87)', () => {
  it('NX650: 54 A / 20 A / 650 W, read-only, from the preset', async () => {
    const { preset, custom, field, values } = await openPowerSupply()
    expect(preset).toHaveAttribute('aria-pressed', 'true')
    expect(custom).toHaveAttribute('aria-pressed', 'false')
    expect(values()).toEqual(['54', '20', '650'])
    for (const l of LIMITS) expect(field(l)).toHaveAttribute('readonly')
    expect(screen.getAllByText('From the NX650 preset')).toHaveLength(3)
    expect(
      screen.getByText('GOLDEN FIELD NX650 — the project’s supply. Display only; no alerts.')
    ).toBeInTheDocument()
  })

  it('typing into a preset field changes nothing', async () => {
    const { sky, user, field, values } = await openPowerSupply()
    await user.type(field('Total power'), '9')
    expect(values()).toEqual(['54', '20', '650'])
    expect(sky.setConfig).not.toHaveBeenCalled()
  })

  it('Custom shows the saved limits, editable; typing saves the number', async () => {
    const { user, custom, field, values, saved } = await openPowerSupply({
      mode: 'preset',
      preset: 'nx650',
      custom: { a12: 40, w: 500 }
    })
    await user.click(custom)
    expect(saved()).toEqual({ mode: 'custom', preset: 'nx650', custom: { a12: 40, w: 500 } })
    expect(values()).toEqual(['40', '', '500'])
    for (const l of LIMITS) expect(field(l)).not.toHaveAttribute('readonly')
    expect(screen.getByText('Combined current of all 5 V outputs (PSU label)')).toBeInTheDocument()

    await user.type(field('5 V rail limit'), '15')
    expect(saved()).toEqual({
      mode: 'custom',
      preset: 'nx650',
      custom: { a12: 40, a5: 15, w: 500 }
    })
  })

  it('Custom keeps its values across a switch to the preset and back', async () => {
    const { user, preset, custom, field, values } = await openPowerSupply({
      mode: 'custom',
      preset: 'nx650',
      custom: { a12: 40 }
    })
    await user.type(field('Total power'), '480')
    await user.click(preset)
    expect(values()).toEqual(['54', '20', '650'])
    await user.click(custom)
    expect(values()).toEqual(['40', '', '480'])
  })

  it('emptying a field saves no limit for it', async () => {
    const { user, field, saved } = await openPowerSupply({
      mode: 'custom',
      preset: 'nx650',
      custom: { a12: 40, a5: 15 }
    })
    await user.clear(field('12 V rail limit'))
    expect(saved()).toEqual({ mode: 'custom', preset: 'nx650', custom: { a5: 15 } })
    expect(field('12 V rail limit')).toHaveAttribute('aria-invalid', 'false')
  })

  it('a non-number is refused: marked invalid, kept on screen, never saved', async () => {
    const { sky, user, field, saved } = await openPowerSupply({
      mode: 'custom',
      preset: 'nx650',
      custom: { a12: 40 }
    })
    await user.clear(field('12 V rail limit'))
    const saves = sky.setConfig.mock.calls.length
    await user.type(field('12 V rail limit'), 'abc')
    expect(field('12 V rail limit')).toHaveValue('abc')
    expect(field('12 V rail limit')).toHaveAttribute('aria-invalid', 'true')
    expect(sky.setConfig.mock.calls.length, 'nothing saved for "abc"').toBe(saves)
    expect(saved()?.custom).toEqual({})
  })

  it.each(['-5', '0', '20000', '1e3'])('"%s" is refused too', async (typed) => {
    const { user, field, saved } = await openPowerSupply({
      mode: 'custom',
      preset: 'nx650',
      custom: {}
    })
    await user.type(field('Total power'), typed)
    expect(field('Total power')).toHaveAttribute('aria-invalid', 'true')
    expect(saved()?.custom.w).not.toBe(Number(typed))
  })
})
