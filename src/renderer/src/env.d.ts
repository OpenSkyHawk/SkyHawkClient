/// <reference types="vite/client" />
import type { SkyhawkApi } from '@shared/ipc'

declare global {
  interface Window {
    skyhawk: SkyhawkApi
  }
  /** Injected at build time from package.json (electron.vite.config.ts). */
  const __APP_VERSION__: string
}

export {}
