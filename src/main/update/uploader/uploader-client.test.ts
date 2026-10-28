// The uploader client against a simulated Gateway, over the real calibration link: every request
// and reply crosses the wire as bytes (test-harness/fake-uploader follows Uploader.cpp).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UPL_STATE, UPL_TARGET } from '@shared/firmware'
import { FAKE_SESSION_IDLE_MS, FakeUploader, flashSteps } from '../../test-harness/fake-uploader'
import { parseIdentity } from '../firmware-image'
import { UPL_TYPE, type UplStatus } from './upl-codec'
import { UplNoAnswer, UplRefused, UploaderClient } from './uploader-client'

// app/debug-log.ts imports electron for its log path; nothing here needs the real thing.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
const { CalLink } = await import('../../hid/calibration/cal-link')
const { uploaderLink } = await import('../../app/uploader-link')

const BRIDGE_030 = new Uint8Array(
  readFileSync(join(__dirname, '..', 'fixtures', 'gateway-bridge-0.3.0.bin'))
)
const ID = (() => {
  const r = parseIdentity(BRIDGE_030)
  if (!r.ok) throw new Error(r.why)
  return r.id
})()

/**
 * A Gateway on the wire: `cut` stops every byte both ways; `drop` loses the next client frame of a
 * type, `dropIn` the next Gateway frame of a type.
 */
function rig(opts: { bundle?: Uint8Array; uploader?: boolean } = {}) {
  const wire = {
    cut: false,
    drop: undefined as number | undefined,
    dropIn: undefined as number | undefined
  }
  const link = new CalLink(
    (d) => {
      if (wire.cut || opts.uploader === false) return
      if (wire.drop !== undefined && d[4] === wire.drop) {
        wire.drop = undefined
        return
      }
      fake.receive(d)
    },
    () => {}
  )
  // Declared after the link that writes to it: nothing is written before both exist.
  const fake: FakeUploader = new FakeUploader((b) => {
    if (wire.cut) return
    if (wire.dropIn !== undefined && b[4] === wire.dropIn) {
      wire.dropIn = undefined
      return
    }
    link.ingest(Buffer.from(b))
  }, opts.bundle)
  const client = new UploaderClient(uploaderLink(link))
  const count = (type: number) => fake.requests.filter((t) => t === type).length
  return { link, fake, client, wire, count }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('uploader client: UPL_INFO', () => {
  it('reads the state, the last result and the bundled cockpit-side version', async () => {
    const { client } = rig({ bundle: BRIDGE_030 })
    await expect(client.info()).resolves.toMatchObject({
      state: 'IDLE',
      lastResult: 'NONE',
      bridgeFw: '0.3.0'
    })
  })

  it('a USB side without the bundle reports none', async () => {
    const { client } = rig()
    expect(await client.info()).not.toHaveProperty('bridgeFw')
  })

  it('a Gateway with no uploader (older than 0.3.0) never answers: undefined', async () => {
    const { client } = rig({ uploader: false })
    const info = client.info()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(info).resolves.toBeUndefined()
  })
})

describe('uploader client: staging', () => {
  it('stages the image chunk by chunk, then UPL_END; progress reaches 100', async () => {
    const { client, fake, count } = rig()
    const pct: number[] = []
    await client.stage(BRIDGE_030, ID, (n) => pct.push(n))
    expect(fake.state).toBe(UPL_STATE.STAGED)
    expect(count(UPL_TYPE.UPL_BEGIN)).toBe(1)
    expect(count(UPL_TYPE.UPL_DATA)).toBe(Math.ceil(ID.imageLength / 256))
    expect(count(UPL_TYPE.UPL_END)).toBe(1)
    expect(pct.at(-1)).toBe(100)
    expect(pct).toEqual([...pct].sort((a, b) => a - b))
  })

  it('sends a chunk again when it got no answer', async () => {
    const { client, wire, count } = rig()
    wire.drop = UPL_TYPE.UPL_DATA
    const staged = client.stage(BRIDGE_030, ID)
    await vi.advanceTimersByTimeAsync(2000)
    await staged
    expect(count(UPL_TYPE.UPL_DATA)).toBe(Math.ceil(ID.imageLength / 256))
  })

  it('a refusal is typed: an image whose bytes don’t match its CRC is IMAGE_CRC', async () => {
    const { client } = rig()
    const bad = BRIDGE_030.slice()
    bad[0x1000] ^= 1
    await expect(client.stage(bad, ID)).rejects.toMatchObject({
      name: 'UplRefused',
      request: 'UPL_END',
      reason: 'IMAGE_CRC'
    })
  })

  it('BUSY while a calibration session is open: nothing staged', async () => {
    const { client, fake } = rig()
    fake.calibrationSession = true
    const e = await client.stage(BRIDGE_030, ID).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UplRefused)
    expect(e).toMatchObject({ request: 'UPL_BEGIN', reason: 'BUSY' })
    expect(fake.state).toBe(UPL_STATE.IDLE)
  })
})

describe('uploader client: flashing', () => {
  const statuses = () => {
    const seen: UplStatus[] = []
    return { seen, cb: (s: UplStatus) => seen.push(s) }
  }

  it('the cockpit side from the bundle: nothing staged, every phase, then OK at 0.3.0', async () => {
    const { client, count } = rig({ bundle: BRIDGE_030 })
    const s = statuses()
    const end = client.flash(UPL_TARGET.bridge, UPL_TARGET.nodeIdKeep, s.cb)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(end).resolves.toEqual({
      lost: false,
      outcome: expect.objectContaining({ result: 'OK', target: 0, fw: '0.3.0', attempts: 1 })
    })
    expect(count(UPL_TYPE.UPL_BEGIN)).toBe(0)
    expect(s.seen.map((x) => x.phase)).toEqual([
      'ENTERING_BOOT',
      'CONNECTED',
      'ERASING',
      'WRITING',
      'WRITING',
      'WRITING',
      'WRITING',
      'VERIFYING',
      'REBOOTING',
      'CONFIRMING'
    ])
    // 539 blocks of 64 bytes for the 0.3.0 image.
    expect(s.seen.at(-4)).toMatchObject({ block: 539, blocks: 539 })
  })

  it('the target is a parameter: a staged image to board 3 (#175)', async () => {
    const { client } = rig()
    await client.stage(BRIDGE_030, ID)
    const s = statuses()
    const end = client.flash(3, UPL_TARGET.nodeIdKeep, s.cb)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await end).lost).toBe(false)
    expect(new Set(s.seen.map((x) => x.target))).toEqual(new Set([3]))
  })

  it('target 0 with nothing staged and no bundle: NOT_STAGED, nothing started', async () => {
    const { client } = rig()
    await expect(
      client.flash(UPL_TARGET.bridge, UPL_TARGET.nodeIdKeep, () => {})
    ).rejects.toMatchObject({ request: 'UPL_FLASH', reason: 'NOT_STAGED' })
  })

  it('BUSY during a calibration session', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    fake.calibrationSession = true
    await expect(client.flash(0, UPL_TARGET.nodeIdKeep, () => {})).rejects.toMatchObject({
      reason: 'BUSY'
    })
  })

  it('a retry shows in UPL_STATUS.attempt, and the result counts the tries', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    fake.next = { steps: [...flashSteps(539).slice(0, 5), ...flashSteps(539, 1)] }
    const s = statuses()
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, s.cb)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(end).resolves.toMatchObject({ outcome: { result: 'OK', attempts: 2 } })
    expect(s.seen.map((x) => x.attempt)).toContain(1)
  })

  it('a failed result is the Gateway’s, as it sent it', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    fake.next = { steps: flashSteps(539).slice(0, 2), result: 'NO_RESPONSE' }
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(1000)
    await expect(end).resolves.toMatchObject({ outcome: { result: 'NO_RESPONSE' } })
  })

  it('UPL_INFO about every second while the flash runs (it keeps the Gateway reporting), none after', async () => {
    const { client, fake, count } = rig({ bundle: BRIDGE_030 })
    fake.stepMs = 1000 // ten phases: about 10 s, like entering + confirming at their slowest
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(10_000)
    await end
    const during = count(UPL_TYPE.UPL_INFO)
    expect(during).toBeGreaterThanOrEqual(9)
    expect(during).toBeLessThanOrEqual(10)
    await vi.advanceTimersByTimeAsync(5000)
    expect(count(UPL_TYPE.UPL_INFO)).toBe(during)
  })

  it('contact lost mid-flash: resolves lost; the Gateway finishes and keeps the result', async () => {
    const { client, fake, wire } = rig({ bundle: BRIDGE_030 })
    fake.stepMs = 1000
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(2500)
    wire.cut = true
    await vi.advanceTimersByTimeAsync(6000)
    await expect(end).resolves.toEqual({ lost: true })
    // Back before the flash ends: still flashing. After it: its result, for UPL_INFO_ACK.
    wire.cut = false
    const during = client.info()
    await expect(during).resolves.toMatchObject({ state: 'FLASHING' })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(client.info()).resolves.toMatchObject({
      state: 'STAGED',
      lastTarget: 0,
      lastResult: 'OK',
      lastFw: '0.3.0'
    })
  })

  it('UPL_RESULT lost on the way: the result is read from UPL_INFO_ACK', async () => {
    const { client, wire } = rig({ bundle: BRIDGE_030 })
    wire.dropIn = UPL_TYPE.UPL_RESULT
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(3000)
    await expect(end).resolves.toEqual({
      lost: false,
      outcome: { via: 'info', result: 'OK', target: 0, fw: '0.3.0' }
    })
  })

  it('the UPL_FLASH ACK lost: the Gateway reads FLASHING, so the flash is followed', async () => {
    const { client, fake, wire } = rig({ bundle: BRIDGE_030 })
    fake.stepMs = 1000
    wire.dropIn = UPL_TYPE.ACK
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(12_000)
    await expect(end).resolves.toMatchObject({ lost: false, outcome: { result: 'OK' } })
  })

  it('follow(): rejoins a flash still running after contact came back', async () => {
    const { client, fake, wire } = rig({ bundle: BRIDGE_030 })
    fake.stepMs = 1000
    const first = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(1500)
    wire.cut = true
    // Three probes unanswered, each after its own 2 s: lost at 6 s, the flash still running.
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toEqual({ lost: true })
    wire.cut = false
    expect((await client.info())?.state).toBe('FLASHING')
    const s = statuses()
    const end = client.follow(s.cb)
    await vi.advanceTimersByTimeAsync(6000)
    await expect(end).resolves.toMatchObject({
      lost: false,
      outcome: { result: 'OK', fw: '0.3.0' }
    })
    expect(s.seen.map((x) => x.phase)).toContain('CONFIRMING')
  })

  it('UPL_STATUS.block is the firmware’s count: full after writing, stale on a retry until it writes', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    fake.next = { steps: [...flashSteps(539).slice(0, 5), ...flashSteps(539, 1)] }
    const s = statuses()
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, s.cb)
    await vi.advanceTimersByTimeAsync(3000)
    await end
    const at = (phase: string, attempt: number) =>
      s.seen.find((x) => x.phase === phase && x.attempt === attempt)?.block
    expect(at('ENTERING_BOOT', 0)).toBe(0)
    // The retry starts where the failed attempt stopped (270), not at 0: progress can't be read
    // from `block` alone until WRITING starts again.
    expect(at('ENTERING_BOOT', 1)).toBe(270)
    expect(at('ERASING', 1)).toBe(270)
    expect(at('VERIFYING', 1)).toBe(539)
    expect(at('CONFIRMING', 1)).toBe(539)
  })

  it('a channel failure on the probe is a miss, never an unhandled rejection', async () => {
    const ack = { type: UPL_TYPE.ACK, payload: Uint8Array.of(UPL_TYPE.UPL_FLASH) }
    const client = new UploaderClient({
      exchange: (type) =>
        type === UPL_TYPE.UPL_FLASH
          ? Promise.resolve({ ok: true as const, frame: ack })
          : Promise.reject(new Error('port write failed')),
      onUnsolicited: () => () => {}
    })
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(3000)
    await expect(end).resolves.toEqual({ lost: true })
  })

  it('the USB side power-cycled: the session and the last result are gone', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(2000)
    await end
    fake.powerCycle()
    await expect(client.info()).resolves.toMatchObject({ state: 'IDLE', lastResult: 'NONE' })
    expect((await client.info())?.lastFw).toBeUndefined()
  })
})

describe('uploader client: UPL_ABORT', () => {
  it('drops what is staged; refused (busy) while flashing', async () => {
    const { client, fake } = rig({ bundle: BRIDGE_030 })
    await client.stage(BRIDGE_030, ID)
    await expect(client.abort()).resolves.toBe('ok')
    expect(fake.state).toBe(UPL_STATE.IDLE)
    fake.stepMs = 1000
    const end = client.flash(0, UPL_TARGET.nodeIdKeep, () => {})
    await vi.advanceTimersByTimeAsync(500)
    await expect(client.abort()).resolves.toBe('busy')
    await vi.advanceTimersByTimeAsync(10_000)
    await end
    // After any result the image stays staged — the bundle copy too — until an abort drops it.
    expect(fake.state).toBe(UPL_STATE.STAGED)
    await expect(client.abort()).resolves.toBe('ok')
  })

  it('no answer is told, never thrown', async () => {
    const { client } = rig({ uploader: false })
    const r = client.abort()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(r).resolves.toBe('no-answer')
  })
})

describe('the simulated Gateway keeps to Uploader.cpp', () => {
  it('a staged image is dropped after 30 s with no client frame', async () => {
    const { client } = rig()
    await client.stage(BRIDGE_030, ID)
    await vi.advanceTimersByTimeAsync(FAKE_SESSION_IDLE_MS)
    await expect(client.info()).resolves.toMatchObject({ state: 'IDLE' })
  })

  it('a request that gets nothing back is UplNoAnswer, not a refusal', async () => {
    const { client } = rig({ uploader: false })
    const e = client.stage(BRIDGE_030, ID).catch((x: unknown) => x)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await e).toBeInstanceOf(UplNoAnswer)
  })
})
