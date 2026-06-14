/// <reference types="vite/client" />
import type { SkyhawkApi } from '@shared/ipc'

declare global {
  interface Window {
    skyhawk: SkyhawkApi
  }
}

export {}
