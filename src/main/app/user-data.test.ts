import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { userDataOverride, USER_DATA_ENV, type UserDataInputs } from './user-data'

const repo = resolve('/work/SkyHawkClient')
const base: UserDataInputs = { isPackaged: false, appPath: repo, env: {}, cwd: repo }

describe('userDataOverride', () => {
  it('keeps the default folder in a packaged build', () => {
    expect(userDataOverride({ ...base, isPackaged: true })).toBeNull()
  })

  it('uses <repo>/.userdata in a dev build', () => {
    expect(userDataOverride(base)).toBe(join(repo, '.userdata'))
  })

  it('honours the env override in a dev build', () => {
    const dir = resolve('/scratch/a')
    expect(userDataOverride({ ...base, env: { [USER_DATA_ENV]: dir } })).toBe(dir)
  })

  it('honours the env override in a packaged build', () => {
    const dir = resolve('/scratch/b')
    expect(userDataOverride({ ...base, isPackaged: true, env: { [USER_DATA_ENV]: dir } })).toBe(dir)
  })

  it('resolves a relative override against the working directory', () => {
    const cwd = resolve('/home/me')
    expect(userDataOverride({ ...base, cwd, env: { [USER_DATA_ENV]: 'tmp/ud' } })).toBe(
      join(cwd, 'tmp', 'ud')
    )
  })

  it('ignores a blank override', () => {
    expect(userDataOverride({ ...base, env: { [USER_DATA_ENV]: '  ' } })).toBe(
      join(repo, '.userdata')
    )
    expect(userDataOverride({ ...base, isPackaged: true, env: { [USER_DATA_ENV]: '' } })).toBeNull()
  })
})
