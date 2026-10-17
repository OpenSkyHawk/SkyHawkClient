// Shared config fixtures for tests (test-only: no production code may import this folder).
import { appSettings } from '@shared/config-file'
import { DEFAULT_CONFIG, type AppSettings } from '@shared/config/ipc'

/** The `app` section of a config export taken from defaults: every setting but the PSU. */
export const DEFAULT_APP_SETTINGS: AppSettings = appSettings(DEFAULT_CONFIG)
