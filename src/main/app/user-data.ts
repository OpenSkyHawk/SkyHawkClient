// Where <userData> lives. Packaged builds keep Electron's default; dev builds use
// <repo>/.userdata so parallel worktrees (and the installed app) don't share
// settings. SKYHAWK_USER_DATA overrides both. Pure, so it's testable without Electron.
import { join, resolve } from 'node:path'
import { jsonFile } from '../config'

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

/**
 * The files main keeps under <userData>, handed to the topics that own them (they never ask
 * electron, P6). Each path is resolved at use, exactly as `join(app.getPath('userData'), name)`
 * was, so the override above still applies. Satisfies MappingPaths, CachePaths and SettingsPaths.
 */
export function storePaths(userData: () => string) {
  return {
    configFile: (): string => join(userData(), 'config.json'),
    calibrationCacheFile: (): string => join(userData(), 'calibration-cache.json'),
    nodeMappingFile: (): string => join(userData(), 'node-mapping.json'),
    /** The saved firmware releases, a folder per version (#192). */
    firmwareDir: (): string => join(userData(), 'firmware'),
    /** The last firmware release check that reached GitHub (#192). */
    releaseCheckFile: (): string => join(userData(), 'release-check.json')
  }
}

export type StorePaths = ReturnType<typeof storePaths>

/**
 * The <userData> files other topics reach through a port, each under the JSON store's one set
 * of rules: satisfies nodes' MappingFileIO, hid/calibration's CacheFileIO and releases'
 * CheckFileIO. config.json is config's own, so settings-service builds its file itself.
 */
export function storeFiles(paths: StorePaths) {
  return {
    mappingFile: jsonFile(() => paths.nodeMappingFile()),
    cacheFile: jsonFile(() => paths.calibrationCacheFile()),
    releaseCheckFile: jsonFile(() => paths.releaseCheckFile())
  }
}
