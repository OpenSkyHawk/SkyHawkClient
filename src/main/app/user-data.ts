// Where <userData> lives. Packaged builds keep Electron's default; dev builds use
// <repo>/.userdata so parallel worktrees (and the installed app) don't share
// settings. SKYHAWK_USER_DATA overrides both. Pure, so it's testable without Electron.
import { join, resolve } from 'node:path'

export const USER_DATA_ENV = 'SKYHAWK_USER_DATA'

export interface UserDataInputs {
  isPackaged: boolean
  /** app.getAppPath(): the repo root in dev. */
  appPath: string
  env: Record<string, string | undefined>
  cwd: string
}

/** The folder to pass to app.setPath('userData'), or null to keep the default. */
export function userDataOverride({ isPackaged, appPath, env, cwd }: UserDataInputs): string | null {
  const fromEnv = env[USER_DATA_ENV]?.trim()
  if (fromEnv) return resolve(cwd, fromEnv)
  if (!isPackaged) return join(appPath, '.userdata')
  return null
}
