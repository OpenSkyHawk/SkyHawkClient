/// <reference types="vite/client" />
import type { PushChannel, PushChannels } from '@shared/ipc'

declare global {
  interface Window {
    skyhawk: {
      on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void
    }
  }
}

export {}
