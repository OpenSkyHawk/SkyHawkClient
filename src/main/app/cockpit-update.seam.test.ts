// SESSION-seam tests for the Gateway cockpit side's update (#187), through the services harness: the
// release check saves firmware 0.3.0 from a fake GitHub; a simulated Gateway answers HELLO and
// GET_CAL, runs the uploader (test-harness/fake-uploader, after Uploader.cpp) and its cockpit side
// answers the roster with its own row and board 1's — silent while it is flashed, or when the test
// says so. The test reads only pushes, intents and the bytes on the wire.
import { describe, expect, it, vi } from 'vitest'
import { CTRL } from '@shared/app'
import { CAL_DATA_FIELD, CAL_PROTO, UPL_STATE } from '@shared/firmware'
import type { FirmwareRow } from '@shared/nodes'
import type { UpdateState } from '@shared/update'
import { stampedImage } from '../../test-fixtures/firmware-image'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { CAL_TYPE, buildFrame } = await import('../hid/calibration/codec')
const { buildRelease, FakeGitHub } = await import('../../test-fixtures/releases')
const { FakeUploader, flashSteps } = await import('../test-harness/fake-uploader')
const { nodeRosterRequest } = await import('../nodes/node-status-wire')
const { UPL_TYPE } = await import('../update/uploader/upl-codec')

const REQUEST = Buffer.from(nodeRosterRequest()).toString('latin1')
/** Board 1 is in your cockpit. */
const COCKPIT = { 'node-mapping.json': { version: 4, nodes: { 1: { added: true } } } }
const MAGIC = CAL_PROTO.magic
/** The 0.3.0 cockpit side's blocks, as the fake counts them for a 2 KB image. */
const BLOCKS = 32

const hex = (n: number) => n.toString(16).padStart(2, '0')
const bytes = (v: string) => v.split('.').map(Number).map(hex).join('')

/** A v4 row: present, healthy, kind `kind`, firmware `v`, a bootloader (or none). */
const row = (id: number, kind: number, v: string, bootloader = true) =>
  `_NODE_STATUS ${hex(id)}01000064000a00001e000000${hex(kind)}${bytes(v)}${bootloader ? '01' : '00'}00\n`

interface Sim {
  /** The USB side's release in HELLO. */
  usb: string
  /** The cockpit side's version; undefined: it sends nothing (in its bootloader, or unpowered). */
  bridge?: string
  bootloader: boolean
}

/**
 * The Gateway on the port: HELLO and GET_CAL answered (GET_DIAG not: older firmware's silence), the
 * uploader, and the cockpit side answering each roster request with its own row and board 1's —
 * never while it is being flashed. A flash's result moves its version (OK, VERSION_MISMATCH) or
 * leaves it silent (written into, or not confirmed).
 */
function gateway(app: Services, sim: Sim, bundle?: string) {
  /** The USB cable is out: nothing reaches the Gateway, nothing comes back; it carries on. */
  let unplugged = false
  const uploader = new FakeUploader(
    (b) => !unplugged && app.serial.receive(b),
    bundle ? stampedImage(bundle) : undefined
  )
  uploader.onFlashEnd = (result, reported) => {
    if (result === 'OK' || result === 'VERSION_MISMATCH') sim.bridge = reported
    if (['WRITE_FAILED', 'VERIFY_FAILED', 'TIMEOUT'].includes(result)) sim.bridge = undefined
  }
  let n = 0
  /** Roster replies on; off: the test drives the bus itself. */
  let roster = true
  /** The next UPL_FLASH is taken, and the cable comes out before its ACK gets back. */
  let cutOnFlash = false
  const answer = () => {
    const out = app.serial.written()
    for (; n < out.length; n++) {
      const w = out[n]!
      if (unplugged) continue
      if (cutOnFlash && MAGIC.every((m, k) => w[k] === m) && w[4] === UPL_TYPE.UPL_FLASH) {
        cutOnFlash = false
        unplugged = true // the ACK and everything after it is lost
        uploader.receive(w)
        app.serial.close()
        continue
      }
      uploader.receive(w)
      if (w.toString('latin1') === REQUEST) {
        if (roster && sim.bridge && uploader.state !== UPL_STATE.FLASHING) {
          app.serial.receive(
            row(0, 3, sim.bridge, sim.bootloader) + row(1, 1, '0.3.0') + '_NODE_STATUS_END 2\n'
          )
        }
        continue
      }
      if (!MAGIC.every((m, k) => w[k] === m)) continue
      const type = w[4]!
      const seq = w[5]!
      const reply = (t: number, p?: Uint8Array) => app.serial.receive(buildFrame(t, seq, p))
      if (type === CAL_TYPE.HELLO) {
        reply(CAL_TYPE.HELLO_ACK, Uint8Array.of(1, 1, 8, ...sim.usb.split('.').map(Number)))
      }
      if (type === CAL_TYPE.GET_CAL) {
        reply(
          CAL_TYPE.CAL_DATA,
          new Uint8Array(CAL_DATA_FIELD.RECORDS + 8 * CAL_PROTO.dataRecBytes)
        )
      }
    }
  }
  return {
    uploader,
    /** The client loses the Gateway (cable out, PC asleep); the Gateway stays powered. */
    unplug() {
      unplugged = true
      app.serial.close()
    },
    plug() {
      unplugged = false
      app.serial.open()
    },
    /** Lose the link the moment the Gateway takes the next UPL_FLASH, before its ACK. */
    cutOnFlash() {
      cutOnFlash = true
    },
    /** Stop or resume answering the roster (the test sends its own lines). */
    roster(on: boolean) {
      roster = on
    },
    /** Let main run for `ms`, answering whatever it asks on the way. */
    async run(ms: number, step = 20) {
      for (let t = 0; t < ms; t += step) {
        await vi.advanceTimersByTimeAsync(step)
        answer()
      }
    },
    /** The uploader requests on the wire, by name, in order (the probe's UPL_INFOs left out). */
    asked(): string[] {
      const name = Object.fromEntries(Object.entries(UPL_TYPE).map(([k, v]) => [v, k]))
      return uploader.requests
        .map((t) => name[t]!)
        .filter((t) => t.startsWith('UPL_') && t !== 'UPL_INFO')
    }
  }
}

const update = (app: Services) => app.lastPush('update:state') as UpdateState | null
const snap = (app: Services) => app.lastPush('cockpit:snapshot')!
const fwRow = (app: Services, key: string): FirmwareRow =>
  snap(app).firmware.rows.find((r) => r.key === key)!
const health = (app: Services) => app.lastPush('device:status')?.gateway

/**
 * Launch with 0.3.0 saved (its cockpit-side image a real stamped one) and the Gateway connected:
 * the USB side on `usb`, carrying `bundle` (or none), the cockpit side on `bridge`.
 */
async function launch(o: {
  usb?: string
  bundle?: string | null
  bridge?: string | null
  bootloader?: boolean
}) {
  const github = new FakeGitHub()
  github.publish(
    buildRelease('0.3.0', { images: { 'gateway-bridge-0.3.0.bin': stampedImage('0.3.0') } })
  )
  const app = makeServices({ github: github.fetch, paths: { files: COCKPIT } })
  await vi.waitFor(() => expect(app.lastPush('releases:state')?.cached).toHaveLength(1))
  const sim: Sim = {
    usb: o.usb ?? '0.3.0',
    ...(o.bridge !== null && { bridge: o.bridge ?? '0.2.9' }),
    bootloader: o.bootloader ?? true
  }
  const gw = gateway(app, sim, o.bundle === null ? undefined : (o.bundle ?? '0.3.0'))
  app.serial.open()
  await gw.run(2_600) // HELLO, the DIAG timeout, GET_CAL, then UPL_INFO
  return { app, gw, sim }
}

/** Start the update and run it to its end (or `ms`); the start intent's own answer is awaited. */
async function runUpdate(app: Services, gw: ReturnType<typeof gateway>, ms = 3_000) {
  const done = app.invoke(CTRL.updateStart)
  await gw.run(ms)
  await done
}

/** Real file I/O (the release cache) under fake timers: wait for it, then move the clock. */
const settle = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 5 })

/** The run reads the saved image (real I/O) between uploader exchanges: run both until it stages. */
const untilStaging = (gw: ReturnType<typeof gateway>) =>
  vi.waitFor(
    async () => {
      await gw.run(20)
      expect(gw.uploader.requests).toContain(UPL_TYPE.UPL_BEGIN)
    },
    { timeout: 10_000, interval: 5 }
  )

describe('#187 the Gateway cockpit side, updated through its uploader', { timeout: 20_000 }, () => {
  it('bridge.status-chips: up to date, update available, newer and manual update only', async () => {
    const ok = await launch({ bridge: '0.3.0' })
    expect(fwRow(ok.app, 'cockpit')).toMatchObject({ status: 'ok', version: '0.3.0' })
    ok.app.dispose()

    const behind = await launch({ bridge: '0.2.9' })
    expect(fwRow(behind.app, 'cockpit')).toMatchObject({
      status: 'update',
      version: '0.2.9',
      to: '0.3.0',
      bundled: true,
      action: 'update',
      attention: true
    })
    behind.app.dispose()

    const newer = await launch({ bridge: '0.3.1' })
    expect(fwRow(newer.app, 'cockpit')).toMatchObject({ status: 'newer', to: '0.3.0' })
    expect(fwRow(newer.app, 'cockpit').action).toBeUndefined()
    newer.app.dispose()

    // No bootloader: never offered, and nothing goes on the wire.
    const manual = await launch({ bridge: '0.2.0', bootloader: false })
    expect(fwRow(manual.app, 'cockpit')).toMatchObject({ status: 'manual' })
    expect(fwRow(manual.app, 'cockpit').action).toBeUndefined()
    expect(manual.gw.asked()).toEqual([])
  })

  it('bridge.usb-first: the USB side behind the release points the Update to its own', async () => {
    const { app } = await launch({ usb: '0.2.9', bundle: '0.2.9', bridge: '0.2.9' })
    expect(fwRow(app, 'cockpit')).toMatchObject({
      status: 'update',
      to: '0.3.0',
      action: 'usb-first'
    })
  })

  it('bridge.bundle: nothing staged; UPL_FLASH 0, phases without staging, then it reports 0.3.0', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const confirm = update(app)!
    expect(confirm).toMatchObject({
      target: { kind: 'cockpit' },
      name: 'Gateway · cockpit side',
      from: '0.2.9',
      to: '0.3.0',
      bundle: true,
      canStart: true,
      estimateSec: 5
    })
    expect(confirm.checks).toEqual([
      { kind: 'relay', ok: true },
      { kind: 'link', ok: true },
      { kind: 'uploader', ok: true },
      { kind: 'calibration', ok: true },
      { kind: 'image', ok: true, version: '0.3.0', bundle: true }
    ])
    expect(confirm.steps.map((s) => s.key)).toEqual(['boot', 'write', 'verify', 'restart', 'ver'])

    await runUpdate(app, gw)
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked()).toEqual(['UPL_FLASH'])
    const flash = gw.uploader.requests.indexOf(UPL_TYPE.UPL_FLASH)
    expect(flash).toBeGreaterThan(-1)
    // The cockpit was paused, then the run showed its writing.
    const runs = app.pushesOf('update:state').filter((s) => s?.phase === 'run')
    expect(runs.find((s) => s!.note)!.note).toEqual({ kind: 'paused' })
    expect(runs.some((s) => s!.steps.some((st) => st.key === 'write' && st.pct === 100))).toBe(true)
    // The row reads the new version on the next roster.
    await gw.run(6_000, 100)
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'ok', version: '0.3.0' })
  })

  it('bridge.bundle-aborts-leftover: something staged at the start is dropped before UPL_FLASH 0', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.state = UPL_STATE.STAGED // a board's image, left by another update (#175)
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    expect(gw.asked()).toEqual(['UPL_ABORT', 'UPL_FLASH'])
    expect(update(app)?.phase).toBe('done')
  })

  it('bridge.no-bundle: the release image is checked, staged, then flashed', async () => {
    const { app, gw } = await launch({ bundle: null, bridge: '0.2.9' })
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'update', to: '0.3.0' })
    expect(fwRow(app, 'cockpit').bundled).toBeUndefined()
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    // The confirm step reads the saved image's identity block: built for node 0, its size.
    await settle(() =>
      expect(update(app)!.checks).toContainEqual({ kind: 'built-for', ok: true, nodeId: 0 })
    )
    expect(update(app)).toMatchObject({ sizeKb: 2, canStart: true })
    expect(update(app)!.bundle).toBeUndefined()
    expect(update(app)!.steps.map((s) => s.key)[0]).toBe('stage')
    const done = app.invoke(CTRL.updateStart)
    await untilStaging(gw)
    await gw.run(3_000)
    await done
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked().filter((t) => t !== 'UPL_DATA')).toEqual([
      'UPL_BEGIN',
      'UPL_END',
      'UPL_FLASH'
    ])
  })

  it('bridge.not-staged: UPL_FLASH 0 refused NOT_STAGED stages the release image', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.bundleGone = true
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await untilStaging(gw)
    await gw.run(3_000)
    await done
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked().filter((t) => t !== 'UPL_DATA')).toEqual([
      'UPL_FLASH',
      'UPL_BEGIN',
      'UPL_END',
      'UPL_FLASH'
    ])
  })

  it('bridge.roster-held: the short boot roster offlines no board; the next full one judges', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    expect(snap(app).views.find((v) => v.entry.nodeId === 1)?.entry.availability).toBe('online')
    gw.uploader.stepMs = 400
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await gw.run(1_000)
    // Paused: the plan's ↻ and hint, every board row PAUSED, the cockpit row UPDATING.
    expect(snap(app).cockpitUpdating).toBe(true)
    expect(fwRow(app, '1')).toMatchObject({ status: 'paused' })
    expect(fwRow(app, 'cockpit')).toMatchObject({
      status: 'updating',
      version: '0.2.9',
      to: '0.3.0'
    })
    await gw.run(2_000)
    // While confirming, the restarted bridge seeds the host with its own row only.
    app.serial.receive(row(0, 0, '0.3.0') + '_NODE_STATUS_END 1\n')
    await gw.run(2_000)
    await done
    expect(update(app)?.phase).toBe('done')
    gw.roster(false)
    // Its boot roster again, before a poll period passed: still judges nothing.
    app.serial.receive(row(0, 3, '0.3.0') + '_NODE_STATUS_END 1\n')
    await gw.run(500)
    expect(snap(app).views.find((v) => v.entry.nodeId === 1)?.entry.availability).toBe('online')
    expect(snap(app).cockpitUpdating).toBe(false)
    gw.roster(true)
    await gw.run(6_000, 100)
    expect(snap(app).views.find((v) => v.entry.nodeId === 1)?.entry.availability).toBe('online')
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'ok', version: '0.3.0' })
  })

  it('bridge.not-responding-retry: the Gateway answers, its cockpit side doesn’t → Retry the update', async () => {
    const { app, gw, sim } = await launch({ bridge: null })
    await gw.run(12_000, 100)
    expect(health(app)).toMatchObject({
      severity: 'err',
      kind: 'not-responding',
      cockpitSide: true
    })
    expect(health(app)?.note).not.toMatch(/unplug/i)
    expect(fwRow(app, 'cockpit')).toMatchObject({
      status: 'not-responding',
      action: 'retry',
      attention: true
    })
    // The boards are unknown, not offline: the Gateway can't see the bus.
    expect(fwRow(app, '1')).toMatchObject({ status: 'not-reported' })
    expect(snap(app).attention.cockpitSide).toEqual({ flag: 'NOT RESPONDING' })
    expect(snap(app).attention.gateway).toBeUndefined()

    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    expect(update(app)).toMatchObject({ fromState: 'not-responding', to: '0.3.0', bundle: true })
    expect(update(app)!.from).toBeUndefined()
    await runUpdate(app, gw)
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(sim.bridge).toBe('0.3.0')
    await gw.run(6_000, 100)
    expect(health(app)?.kind).not.toBe('not-responding')
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'ok' })
  })

  it('bridge.no-response: the instruction, no clock; Retry says press again from its start', async () => {
    const { app, gw, sim } = await launch({ bridge: '0.2.9' })
    gw.uploader.next = { steps: [{ phase: 'ENTERING_BOOT' }], result: 'NO_RESPONSE' }
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    expect(update(app)).toMatchObject({
      phase: 'fail',
      failure: { kind: 'no-response' },
      after: 'refused'
    })
    // The cockpit side may sit in its bootloader for 30 s: its silence isn't "not responding".
    sim.bridge = undefined
    await gw.run(25_000, 250)
    expect(health(app)?.kind).not.toBe('not-responding')
    // Retry: the press-again prompt from the start of the attempt, then caught.
    sim.bridge = '0.2.9'
    const retry = app.invoke(CTRL.updateRetry)
    await gw.run(50)
    expect(update(app)).toMatchObject({ phase: 'run', note: { kind: 'press-reset' } })
    await gw.run(3_000)
    await retry
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
  })

  it('bridge.not-responding waits out the 30 s after a refused update, then shows', async () => {
    const { app, gw, sim } = await launch({ bridge: '0.2.9' })
    gw.uploader.next = { steps: [{ phase: 'ENTERING_BOOT' }], result: 'NO_RESPONSE' }
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    app.invoke(CTRL.updateClose)
    sim.bridge = undefined // it never came back
    await gw.run(28_000, 250)
    expect(fwRow(app, 'cockpit').status).not.toBe('not-responding')
    await gw.run(14_000, 250)
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'not-responding', action: 'retry' })
  })

  it('bridge.retry-note: attempt 1 is a note, never a step back; then recovered', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.next = {
      steps: [...flashSteps(BLOCKS).slice(0, 5), ...flashSteps(BLOCKS, 1)]
    }
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw, 4_000)
    const runs = app.pushesOf('update:state').filter((s) => s?.phase === 'run') as UpdateState[]
    const notes = runs.map((s) => s.note?.kind).filter((k, i, a) => k && k !== a[i - 1])
    expect(notes).toEqual(['paused', 'retrying', 'recovered'])
    expect(runs.find((s) => s.note?.kind === 'retrying')!.note).toEqual({
      kind: 'retrying',
      n: 1,
      of: 2
    })
    // The step the run is on never goes back, and writing's progress never drops.
    const on = runs.map((s) => s.steps.findIndex((st) => st.state === 'on'))
    expect(on).toEqual([...on].sort((a, b) => a - b))
    const pct = runs.map((s) => s.steps.find((st) => st.key === 'write')?.pct ?? -1)
    const written = pct.filter((p) => p >= 0)
    expect(written).toEqual([...written].sort((a, b) => a - b))
    expect(update(app)?.phase).toBe('done')
  })

  it('bridge.write-failed: Retry re-sends UPL_FLASH 0 with no staging', async () => {
    const { app, gw } = await launch({ bundle: null, bridge: '0.2.9' })
    gw.uploader.next = { steps: flashSteps(BLOCKS).slice(0, 6), result: 'WRITE_FAILED' }
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await untilStaging(gw)
    await gw.run(3_000)
    await done
    expect(update(app)).toMatchObject({
      phase: 'fail',
      failure: { kind: 'write-failed' },
      after: 'erased'
    })
    const sent = gw.asked().length
    const retry = app.invoke(CTRL.updateRetry)
    await gw.run(3_000)
    await retry
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked().slice(sent)).toEqual(['UPL_FLASH'])
  })

  it('bridge.client-cut-off: the port goes mid-flash; back to a flash still running, then OK', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.stepMs = 2_000
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await gw.run(2_000)
    gw.unplug() // the client is cut off; the Gateway carries on
    await gw.run(6_000, 100)
    expect(update(app)).toMatchObject({ phase: 'run', note: { kind: 'cut-off' } })
    gw.plug()
    await gw.run(3_000, 50)
    expect(update(app)).toMatchObject({ phase: 'run', note: { kind: 'back' } })
    await gw.run(12_000, 50)
    await done
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    // Never aborted: a flash can't be stopped.
    expect(gw.asked()).not.toContain('UPL_ABORT')
  })

  it('bridge.client-cut-off: back after the flash ended, its result read from UPL_INFO', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.stepMs = 500
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await gw.run(1_000)
    gw.unplug()
    await gw.run(10_000, 100) // it finishes meanwhile, its result kept
    gw.plug()
    await gw.run(5_000, 50)
    await done
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
  })

  it('bridge.cut-off-close: Close while cut off leaves the Gateway to finish; a later update follows it', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.stepMs = 2_000
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await gw.run(2_000)
    gw.unplug()
    await gw.run(6_000, 100)
    expect(update(app)).toMatchObject({ phase: 'run', note: { kind: 'cut-off' }, closable: true })
    // The drive watch runs while cut off: a Gateway back in its update drive shows.
    app.serial.listed(false)
    app.drive.mounted = '/Volumes/RPI-RP2'
    await gw.run(6_000, 250)
    expect(fwRow(app, 'usb').status).toBe('in-drive')
    app.drive.mounted = undefined
    app.serial.listed(true)
    // Close: the run is left; the cockpit's pause and the roster hold end with it.
    app.invoke(CTRL.updateClose)
    await gw.run(100)
    await done
    expect(update(app)).toBeNull()
    expect(snap(app).cockpitUpdating).toBe(false)
    // Back, still flashing: a new update reads UPL_INFO and follows it, never aborting it.
    gw.plug()
    await gw.run(3_000, 50)
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const again = app.invoke(CTRL.updateStart)
    await gw.run(14_000, 50)
    await again
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked()).toEqual(['UPL_FLASH'])
  })

  it('bridge.flash-ack-lost: the link goes as UPL_FLASH is taken; the run waits and follows', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.stepMs = 1_000
    gw.cutOnFlash()
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    const done = app.invoke(CTRL.updateStart)
    await gw.run(5_000, 100)
    // Not a failure: whether it started is unknown, so the run waits for the Gateway.
    expect(update(app)).toMatchObject({ phase: 'run', note: { kind: 'cut-off' } })
    gw.plug()
    await gw.run(2_000, 50)
    // Back while it flashes: still paused, the roster held, no red Gateway.
    expect(snap(app).cockpitUpdating).toBe(true)
    expect(health(app)?.kind).not.toBe('not-responding')
    await gw.run(10_000, 50)
    await done
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(gw.asked()).toEqual(['UPL_FLASH'])
  })

  it('bridge.write-failed-unseen-erase: WRITE_FAILED is after the erase even when ERASING wasn’t seen', async () => {
    const { app, gw, sim } = await launch({ bridge: '0.2.9' })
    // Statuses missed: only the bootloader's entry reached the client before the result.
    gw.uploader.next = {
      steps: [{ phase: 'ENTERING_BOOT' }, { phase: 'CONNECTED' }],
      result: 'WRITE_FAILED'
    }
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    expect(update(app)).toMatchObject({
      phase: 'fail',
      failure: { kind: 'write-failed' },
      after: 'erased'
    })
    expect(sim.bridge).toBeUndefined() // erased: it waits in its bootloader
    app.invoke(CTRL.updateClose)
    // Its silence isn't muted for 30 s: it is not responding now.
    await gw.run(14_000, 250)
    expect(fwRow(app, 'cockpit')).toMatchObject({ status: 'not-responding', action: 'retry' })
  })

  describe('bridge.usb-power-cycle: the result is lost; the cockpit side’s row decides', () => {
    async function cut(written: boolean) {
      const r = await launch({ bridge: '0.2.9' })
      r.gw.uploader.stepMs = 500
      r.app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
      const done = r.app.invoke(CTRL.updateStart)
      await r.gw.run(written ? 2_000 : 300)
      r.gw.unplug()
      r.gw.uploader.powerCycle()
      return { ...r, done }
    }

    it('no row (cut after the erase): not responding, Retry finishes it', async () => {
      const { app, gw, sim, done } = await cut(true)
      sim.bridge = undefined
      gw.plug()
      await gw.run(12_000, 50)
      await done
      expect(update(app)).toMatchObject({
        phase: 'fail',
        failure: { kind: 'not-responding' },
        after: 'erased'
      })
    })

    it('the old version (cut before the erase): nothing changed', async () => {
      const { app, gw, done } = await cut(false)
      gw.plug()
      await gw.run(12_000, 50)
      await done
      expect(update(app)).toMatchObject({
        phase: 'fail',
        failure: { kind: 'interrupted' },
        after: 'refused'
      })
    })

    it('the new version (cut while confirming): done', async () => {
      const { app, gw, sim, done } = await cut(true)
      sim.bridge = '0.3.0'
      gw.plug()
      await gw.run(12_000, 50)
      await done
      expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    })
  })

  it('bridge.busy-calibration: a calibration session on the Gateway refuses UPL_FLASH', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    gw.uploader.calibrationSession = true
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    expect(update(app)).toMatchObject({ phase: 'fail', failure: { kind: 'busy' } })
    expect(update(app)!.after).toBeUndefined()
  })

  it('bridge.abort-on-close: Close after the result drops the staged copy', async () => {
    const { app, gw } = await launch({ bridge: '0.2.9' })
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    await runUpdate(app, gw)
    expect(update(app)?.phase).toBe('done')
    expect(gw.uploader.state).toBe(UPL_STATE.STAGED)
    app.invoke(CTRL.updateClose)
    await gw.run(200)
    expect(gw.asked().at(-1)).toBe('UPL_ABORT')
    expect(gw.uploader.state).toBe(UPL_STATE.IDLE)
    expect(update(app)).toBeNull()
  })

  it('a Gateway without the uploader: the confirm blocks and points to the USB side', async () => {
    const { app, gw } = await launch({ usb: '0.3.0', bridge: '0.2.9' })
    // Older firmware: UPL_INFO goes unanswered (simulated by dropping every uploader reply).
    gw.uploader.receive = () => {}
    gw.unplug()
    gw.plug()
    await gw.run(5_000)
    app.invoke(CTRL.updateOpen, { kind: 'cockpit' })
    expect(update(app)!.checks).toContainEqual({ kind: 'uploader', ok: false })
    expect(update(app)!.canStart).toBe(false)
  })
})
