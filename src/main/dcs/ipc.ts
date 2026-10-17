// dcs's intents: relay Start / Stop, the Log tab's export, recording a capture and opening one to
// replay. app/ipc.ts registers them, in its order (they are not registered together).
import { writeFileSync } from 'node:fs'
import type { IpcRegistrar } from '@shared/app'
import { DCS_CTRL, type CaptureState, type ReplayLoad } from '@shared/dcs'
import type { DcsRelay } from './dcs-relay'
import type { SessionRecorder } from './session-recorder'

/** The dialogs dcs's intents open (app/dialogs.ts). Each resolves to the picked path, if any. */
export interface DcsDialogs {
  saveLog(): Promise<string | undefined>
  saveCapture(): Promise<string | undefined>
  openCapture(): Promise<string | undefined>
}

export interface DcsIpcDeps {
  relay: DcsRelay
  recorder: SessionRecorder
  dialogs: DcsDialogs
}

export function registerDcsIpc(ipc: IpcRegistrar, deps: DcsIpcDeps): void {
  const { relay, recorder, dialogs } = deps
  ipc.handle(DCS_CTRL.relayStart, () => relay.start())
  ipc.handle(DCS_CTRL.relayStop, () => relay.stop())
  ipc.handle(DCS_CTRL.relayToggle, (_e, relaying: boolean) => relay.toggle(relaying))

  ipc.handle(DCS_CTRL.logExport, async (_e, text: string) => {
    const filePath = await dialogs.saveLog()
    if (!filePath) return {}
    writeFileSync(filePath, text)
    return { path: filePath }
  })

  // The Record controls and the Capture card show the answer (relay:facts, R3.3).
  ipc.handle(DCS_CTRL.captureToggle, async (): Promise<CaptureState> => {
    const state = await toggleCapture()
    relay.showCapture(state)
    return state
  })
  const toggleCapture = async (): Promise<CaptureState> => {
    if (recorder.isRecording()) {
      const { path, events } = recorder.stopRecording()
      return { recording: false, path, events }
    }
    const filePath = await dialogs.saveCapture()
    if (!filePath) return { recording: false }
    recorder.startRecording(filePath)
    return { recording: true, path: filePath }
  }

  ipc.handle(DCS_CTRL.replayOpen, async (): Promise<ReplayLoad> => {
    const load = await openReplay()
    relay.showReplay(load)
    return load
  })
  const openReplay = async (): Promise<ReplayLoad> => {
    const path = await dialogs.openCapture()
    if (!path) return { loaded: false }
    try {
      const info = relay.loadReplay(path)
      return { loaded: true, path, events: info.events, durationMs: info.durationMs }
    } catch {
      return { loaded: false }
    }
  }
}
