// Services harness for SESSION-seam tests (test-only: production code never imports this).
//
// `makeServices()` launches the main process the way app/bootstrap.ts does — settings loaded
// from config.json, then the device link opened — with fakes standing in for the hardware and the
// outside world: the SimGateway serial port, the DCS transport, HID, the clock and <userData>.
//
// A test sees only what the app shows the outside world:
//   - pushes to the renderer (channel + payload),
//   - IPC intents (renderer → main requests, by their CTRL channel name),
//   - the files main writes under <userData>,
//   - bytes on the fake serial port and the fake DCS socket,
//   - requests to a fake GitHub (the firmware release check),
//   - a clock it advances.
// Never the objects inside. The harness wraps `AppServices` (R2.3c): when the services moved, only
// this file changed, and the tests written against it kept passing as they are.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'
import { CTRL, type IpcListener, type PushChannel, type PushChannels } from '@shared/app'
import type { AppConfig, ConfigEdit } from '@shared/config'
import type { RecordState, ReplayLoad } from '@shared/dcs'
import type { AdoptRequest, AdoptSpec, MappingPatch, ResetOptions } from '@shared/nodes'
import type { FetchPort } from '../releases'

// ── the outside world, faked ─────────────────────────────────────────────────

/** What the fakes share with the harness instance currently running. */
const world = {
  userData: '',
  portPath: '/dev/fake',
  serialNumber: 'TESTSERIAL',
  /** Every byte written to any serial port, in order: the wire, across reconnects. */
  serialOut: [] as Buffer[],
  /** Every byte sent to DCS, in order, across relay restarts. */
  dcsOut: [] as Buffer[],
  transportConnectsOnStart: false,
  /** GitHub, as Electron's net.fetch reaches it: unreachable unless a test serves one. */
  github: (() => Promise.reject(new Error('offline'))) as FetchPort,
  /** What the file dialogs answer: a file name in <userData>, or none (cancelled). */
  dialogs: {
    saveCapture: undefined as string | undefined,
    openCapture: undefined as string | undefined
  }
}

/** Stand-in for SerialBridge: one instance per port open, the latest is the board. */
class FakeSerial {
  static last?: FakeSerial
  dataCb: (c: Buffer) => void = () => {}
  closeCb: () => void = () => {}
  openCb: (p: string) => void = () => {}
  errorCb: (e: Error) => void = () => {}
  stopped = false
  constructor() {
    FakeSerial.last = this
  }
  onData(cb: (c: Buffer) => void) {
    this.dataCb = cb
  }
  onMonitor() {}
  onError(cb: (e: Error) => void) {
    this.errorCb = cb
  }
  onOpen(cb: (p: string) => void) {
    this.openCb = cb
  }
  onClose(cb: () => void) {
    this.closeCb = cb
  }
  start() {}
  stop() {
    this.stopped = true
  }
  write(d: Buffer) {
    world.serialOut.push(Buffer.from(d))
  }
  portPath() {
    return world.portPath
  }
}

/** Stand-in for the DCS transport (UDP / TCP): captures what would go to DCS. */
class FakeTransport {
  static last?: FakeTransport
  exportCb: (c: Buffer) => void = () => {}
  connectedCb: (c: boolean) => void = () => {}
  errorCb: (e: Error) => void = () => {}
  constructor() {
    FakeTransport.last = this
  }
  start() {
    if (world.transportConnectsOnStart) this.connectedCb(true)
  }
  stop() {
    this.connectedCb(false) // as the real UDP transport does
  }
  send(d: Buffer) {
    world.dcsOut.push(Buffer.from(d))
  }
  onExport(cb: (c: Buffer) => void) {
    this.exportCb = cb
  }
  onError(cb: (e: Error) => void) {
    this.errorCb = cb
  }
  onConnected(cb: (c: boolean) => void) {
    this.connectedCb = cb
  }
}

/** Stand-in for HidReader (node-hid is optional, and the device is fake): a silent joystick. */
class FakeHid {
  onError() {}
  onReport() {}
  start() {}
  reopen() {}
  stop() {}
  sampleRate() {}
  snapshot() {
    return { axes: [], buttons: [], hats: [], ageMs: 0, rateHz: 0 }
  }
}

// Registered before main is imported (below), so main is built against the fakes. Paths are
// relative to this file. The mapping, settings and calibration-cache stores are real: they write
// <userData>, through the same store paths app/bootstrap.ts hands them. electron is still faked
// for app's own use of it (debug.log, the version).
vi.doMock('electron', () => ({
  app: {
    getPath: () => world.userData,
    getVersion: () => '0.0.0-test',
    isPackaged: false
  },
  net: { fetch: (url: string, init: Parameters<FetchPort>[1]) => world.github(url, init) }
}))
vi.doMock('../gateway/serial-bridge', () => ({
  SerialBridge: FakeSerial,
  PortNotFoundError: class PortNotFoundError extends Error {},
  SIMGATEWAY_VID: 0x2e8a,
  SIMGATEWAY_PID: 0x4134,
  findSimGatewayPort: () => Promise.resolve(world.portPath),
  listSerialPorts: () =>
    Promise.resolve([{ path: world.portPath, serialNumber: world.serialNumber }])
}))
vi.doMock('../dcs/transports', () => ({ createTransport: () => new FakeTransport() }))
vi.doMock('../hid/hid-reader', () => ({ HidReader: FakeHid }))

const { AppServices } = await import('../app/app-services')
const { registerDcsIpc } = await import('../dcs')
const { storePaths } = await import('../app/user-data')
const { PortNotFoundError } = await import('../gateway/serial-bridge')

// ── the harness ──────────────────────────────────────────────────────────────

export interface ServicesOptions {
  /** The SimGateway's serial port: where it enumerates, and its USB serial number. */
  serial?: { portPath?: string; serialNumber?: string }
  /** The DCS end of the relay. `connectOnStart`: DCS is running, so a started relay links up. */
  transport?: { connectOnStart?: boolean }
  /** The fake clock, ms since the epoch. Every timer in main runs on it. */
  clock?: { start?: number }
  /**
   * <userData>: a fresh temporary folder, seeded with `files` before launch (a string is written
   * as is, anything else as JSON). `config.json` is what the app launches with.
   */
  paths?: { files?: Record<string, unknown> }
  /** GitHub, for the firmware release check (src/test-fixtures/releases.ts). Default: offline. */
  github?: FetchPort
}

type Push = { [C in PushChannel]: { channel: C; payload: PushChannels[C] } }[PushChannel]

/** The default clock: 2026-10-16 12:00:00 UTC. */
const CLOCK_START = Date.UTC(2026, 9, 16, 12, 0, 0)

const live = new Set<Services>()

export type Services = ReturnType<typeof launch>

/**
 * Launch the app's main-process services against fakes. Cleaned up after the test (timers back to
 * real, the app quit, <userData> deleted); `dispose()` does it sooner.
 */
export function makeServices(opts: ServicesOptions = {}): Services {
  const svc = launch(opts)
  live.add(svc)
  try {
    onTestFinished(() => svc.dispose())
  } catch {
    // outside a running test (a hook): the caller disposes
  }
  return svc
}

function launch(opts: ServicesOptions) {
  for (const other of live) other.dispose() // one app at a time: the fakes are shared
  vi.useFakeTimers({ now: opts.clock?.start ?? CLOCK_START })

  const userData = mkdtempSync(join(tmpdir(), 'skyhawk-services-'))
  for (const [name, value] of Object.entries(opts.paths?.files ?? {})) {
    writeFileSync(
      join(userData, name),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    )
  }
  Object.assign(world, {
    userData,
    portPath: opts.serial?.portPath ?? '/dev/fake',
    serialNumber: opts.serial?.serialNumber ?? 'TESTSERIAL',
    serialOut: [],
    dcsOut: [],
    transportConnectsOnStart: opts.transport?.connectOnStart ?? false,
    github: opts.github ?? (() => Promise.reject(new Error('offline'))),
    dialogs: { saveCapture: undefined, openCapture: undefined }
  })
  FakeSerial.last = undefined
  FakeTransport.last = undefined

  // app/bootstrap.ts: the <userData> files, handed to the stores.
  const paths = storePaths(() => world.userData)

  const pushes: Push[] = []
  const services = new AppServices((channel, payload) => {
    pushes.push({ channel, payload } as Push)
  }, paths)

  // dcs's capture intents, as dcs/ipc.ts registers them, over dialogs that answer from `world`.
  const dcsIntents = new Map<string, IpcListener>()
  const inUserData = (name?: string) => (name === undefined ? undefined : join(userData, name))
  registerDcsIpc(
    { handle: (channel, listener) => void dcsIntents.set(channel, listener) },
    {
      relay: services.relay,
      recorder: services.recorder,
      dialogs: {
        saveLog: () => Promise.resolve(undefined),
        saveCapture: () => Promise.resolve(inUserData(world.dialogs.saveCapture)),
        openCapture: () => Promise.resolve(inUserData(world.dialogs.openCapture))
      }
    }
  )
  const dcsIntent = <T>(channel: string): Promise<T> =>
    dcsIntents.get(channel)!(undefined) as Promise<T>

  // app/ipc.ts registerIpc() and the topics' ipc.ts: the renderer's requests main answers.
  const intents = {
    [CTRL.configGet]: () => services.settings.view(),
    [CTRL.configSet]: (patch: Partial<AppConfig>) => services.settings.apply(patch),
    [CTRL.configEdit]: (edit: ConfigEdit) => services.settings.edit(edit),
    [CTRL.relayStart]: () => services.relay.start(),
    [CTRL.relayStop]: () => services.relay.stop(),
    [CTRL.relayToggle]: (relaying: boolean) => services.relay.toggle(relaying),
    [CTRL.captureToggle]: () => dcsIntent<RecordState>(CTRL.captureToggle),
    [CTRL.replayOpen]: () => dcsIntent<ReplayLoad>(CTRL.replayOpen),
    // A renderer's first pull on (re)load (app/ipc.ts): the old page's calibration view goes with
    // it; what main holds for the screen comes back in the bundle (N1).
    [CTRL.relayStatus]: () => {
      services.calibration.workflow.rendererLoaded()
      services.nodes.rendererLoaded()
      services.rendererLoaded()
      return services.status()
    },
    [CTRL.deviceConnect]: () => services.connection.connect(),
    [CTRL.deviceDisconnect]: () => services.connection.disconnect(),
    [CTRL.nodesGet]: () => services.nodes.snapshot(),
    [CTRL.nodeMappingSet]: (id: number, patch: MappingPatch) =>
      services.nodes.setMapping(id, patch),
    [CTRL.nodeMappingAdopt]: (id: number, spec: AdoptSpec) => services.nodes.adopt(id, spec),
    [CTRL.nodeMappingForget]: (id: number) => services.nodes.forget(id),
    [CTRL.nodeMappingResetNode]: (id: number) => services.nodes.resetBoard(id),
    [CTRL.nodeMappingReset]: (opts?: ResetOptions) => services.nodes.resetAll(opts),
    [CTRL.nodeMappingResetPreview]: () => services.nodes.previewReset(),
    [CTRL.nodeRegistry]: () => services.nodes.registry(),
    [CTRL.nodeMappingHide]: (id: number, on: boolean) => services.nodes.hide(id, on),
    [CTRL.nodeMappingAddAll]: (bulk: AdoptRequest[]) => services.nodes.addAll(bulk),
    [CTRL.nodeMappingUnhide]: (ids: number[]) => services.nodes.unhide(ids),
    [CTRL.serialMonitor]: (on: boolean) => services.serialMonitor.setSerialMonitor(on),
    [CTRL.eventsGet]: () => services.journal.snapshot(),
    [CTRL.eventsClear]: () => services.journal.clear(),
    [CTRL.releasesGet]: () => services.releases.state(),
    [CTRL.releasesCheck]: () => services.releases.checkNow(),
    [CTRL.releasesClear]: () => services.releases.clear()
  }
  type Intents = typeof intents

  // app/bootstrap.ts app.whenReady(): seed from persisted settings, then bring the device link up.
  services.settings.load()
  services.open()

  let quit = false
  let disposed = false

  const port = (): FakeSerial => {
    const s = FakeSerial.last
    if (!s || s.stopped) throw new Error('no serial port is open: the link is not looking for one')
    return s
  }
  const dcs = (): FakeTransport => {
    const t = FakeTransport.last
    if (!t) throw new Error('no DCS transport: the relay has not been started')
    return t
  }
  const bytes = (data: string | Buffer | Uint8Array): Buffer =>
    typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data)

  return {
    /** Every push to the renderer, in order. */
    pushes: pushes as readonly Push[],

    /** The payloads pushed on one channel, in order. */
    pushesOf<C extends PushChannel>(channel: C): PushChannels[C][] {
      return pushes.filter((p) => p.channel === channel).map((p) => p.payload as PushChannels[C])
    },

    /** The most recent payload pushed on one channel. */
    lastPush<C extends PushChannel>(channel: C): PushChannels[C] | undefined {
      return this.pushesOf(channel).at(-1)
    },

    /** A renderer → main request, as `ipcRenderer.invoke(channel, ...args)` makes it. */
    invoke<C extends keyof Intents>(
      channel: C,
      ...args: Parameters<Intents[C]>
    ): ReturnType<Intents[C]> {
      const handler = intents[channel] as (...a: unknown[]) => ReturnType<Intents[C]>
      return handler(...args)
    },

    /** The SimGateway end of the USB cable. */
    serial: {
      /** The port opens: the board is plugged in (or replugged) and found. */
      open(): void {
        port().openCb(world.portPath)
      },
      /** The port closes under the app: the board is unplugged. */
      close(): void {
        port().closeCb()
      },
      /** The board sends these bytes (a string is taken byte for byte). */
      receive(data: string | Buffer | Uint8Array): void {
        port().dataCb(bytes(data))
      },
      /** No board is plugged in. */
      notFound(): void {
        port().errorCb(new PortNotFoundError())
      },
      /** The port fails to open, or fails while open. */
      fail(message: string): void {
        port().errorCb(new Error(message))
      },
      /** Everything the app wrote to the board, across reconnects. */
      written(): Buffer[] {
        return [...world.serialOut]
      },
      /** `written()` as one latin1 string. */
      writtenText(): string {
        return Buffer.concat(world.serialOut).toString('latin1')
      },
      clearWritten(): void {
        world.serialOut.length = 0
      }
    },

    /** DCS's end of the relay. */
    transport: {
      /** DCS sends a chunk of the export stream. */
      export(data: string | Buffer | Uint8Array): void {
        dcs().exportCb(bytes(data))
      },
      /** The DCS link comes up (true) or drops (false). */
      connected(up: boolean): void {
        dcs().connectedCb(up)
      },
      fail(message: string): void {
        dcs().errorCb(new Error(message))
      },
      /** Everything the app sent to DCS, across relay restarts. */
      sent(): Buffer[] {
        return [...world.dcsOut]
      },
      clearSent(): void {
        world.dcsOut.length = 0
      }
    },

    clock: {
      now(): number {
        return Date.now()
      },
      /** Move time on, running every timer that falls due. */
      advance(ms: number): void {
        vi.advanceTimersByTime(ms)
      }
    },

    /** <userData>, as main left it on disk. */
    files: {
      dir: userData,
      list(): string[] {
        return existsSync(userData) ? readdirSync(userData).sort() : []
      },
      /** A file's text, or undefined if main has not written it. */
      text(name: string): string | undefined {
        const p = join(userData, name)
        return existsSync(p) ? readFileSync(p, 'utf8') : undefined
      },
      /** A JSON file, parsed; undefined if main has not written it. */
      json<T = unknown>(name: string): T | undefined {
        const t = this.text(name)
        return t === undefined ? undefined : (JSON.parse(t) as T)
      }
    },

    /** The file dialogs: what the next save / open picks, as a file name in <userData>. */
    dialogs: {
      saveCapture(name: string | undefined): void {
        world.dialogs.saveCapture = name
      },
      openCapture(name: string | undefined): void {
        world.dialogs.openCapture = name
      }
    },

    /** The window closes (`window-all-closed`): the relay stops, the app keeps running. */
    closeWindow(): void {
      services.relay.stop()
    },

    /** The app quits (`will-quit`). */
    quit(): void {
      if (quit) return
      quit = true
      services.shutdown()
    },

    /** Quit if still running, put real timers back and delete <userData>. Idempotent. */
    dispose(): void {
      if (disposed) return
      disposed = true
      this.quit()
      vi.useRealTimers()
      rmSync(userData, { recursive: true, force: true })
      live.delete(this as Services)
    }
  }
}
