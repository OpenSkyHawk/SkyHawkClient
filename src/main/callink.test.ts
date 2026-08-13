import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAL_AXIS_NONE, CAL_NACK, CAL_TYPE, buildFrame } from '@shared/calibration'

// debug.ts imports electron for its log path; nothing here needs the real thing.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { CalLink, CalNackError, CalTimeoutError } = await import('./callink')
type CalLinkT = InstanceType<typeof CalLink>

const ascii = (s: string) => Buffer.from(s, 'ascii')

/** Harness: captures what the link writes and lets a test answer as the device would. */
function rig() {
  const written: Buffer[] = []
  const raw: { idx: number; raw: number; cal: number }[] = []
  const link: CalLinkT = new CalLink(
    (d) => written.push(d),
    (s) => raw.push(s)
  )
  /** The frame the link most recently sent, decoded far enough to reply to it. */
  const sent = (): { type: number; seq: number } => {
    const b = written[written.length - 1]!
    return { type: b[4]!, seq: b[5]! }
  }
  const reply = (type: number, seq: number, payload?: Uint8Array) =>
    link.ingest(Buffer.from(buildFrame(type, seq, payload)))
  return { link, written, raw, sent, reply }
}

const HELLO_ACK = Uint8Array.of(1, 1, 8, 0, 1, 0)
const CAL_DATA = (() => {
  const p = new Uint8Array(82)
  p[0] = 0b0000_0011 // axes 0,1 present
  p[1] = 0b0000_0001 // axis 0 calibrated
  return p
})()

describe('CalLink request/response', () => {
  it('resolves a request against its echoed SEQ', async () => {
    const { link, sent, reply } = rig()
    const p = link.hello()
    reply(CAL_TYPE.HELLO_ACK, sent().seq, HELLO_ACK)
    await expect(p).resolves.toMatchObject({ proto: 1, axisSlots: 8 })
  })

  it('ignores a reply carrying a SEQ nobody is waiting on', async () => {
    const { link, sent, reply } = rig()
    const p = link.hello()
    reply(CAL_TYPE.HELLO_ACK, (sent().seq + 9) & 0xff, HELLO_ACK)
    reply(CAL_TYPE.HELLO_ACK, sent().seq, HELLO_ACK)
    await expect(p).resolves.toBeDefined()
  })

  it('turns a NACK into a typed error naming the axis', async () => {
    const { link, sent, reply } = rig()
    const p = link.commit({ idx: 3, min: 100, centre: 50, max: 500 })
    reply(CAL_TYPE.NACK, sent().seq, Uint8Array.of(CAL_TYPE.COMMIT, CAL_NACK.BAD_ORDER, 3))
    await expect(p).rejects.toBeInstanceOf(CalNackError)
    await p.catch((e: InstanceType<typeof CalNackError>) => {
      expect(e.reason).toBe(CAL_NACK.BAD_ORDER)
      expect(e.detail).toBe(3)
    })
  })

  it('does not reuse a sequence number that is still in flight', async () => {
    // Consecutive SEQs differ from the increment alone, so two requests prove nothing. The
    // check only earns its keep once the counter wraps back into a SEQ still awaiting a reply —
    // 256 requests later. A collision there would resolve the wrong caller's promise.
    vi.useFakeTimers()
    try {
      const { link, written } = rig()
      const inflight = Array.from({ length: 256 }, () => link.getCal().catch(() => null))
      const seqs = written.map((b) => b[5]!)
      expect(new Set(seqs).size, 'all 256 in-flight sequence numbers must be distinct').toBe(256)

      // Every value is now taken, so there is nothing safe left to allocate.
      await expect(link.getCal()).rejects.toThrow(/no free sequence number/)

      await vi.advanceTimersByTimeAsync(2000)
      await Promise.all(inflight)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses a sequence number once its reply has arrived', async () => {
    const { link, written, sent, reply } = rig()
    const a = link.hello()
    const first = sent().seq
    reply(CAL_TYPE.HELLO_ACK, first, HELLO_ACK)
    await a
    written.length = 0
    // A full lap of the 256-value space brings the counter back to `first` — which it can only
    // reach if answered requests are released from the pending map rather than accumulating.
    for (let i = 0; i < 256; i++) {
      const p = link.getCal()
      reply(CAL_TYPE.CAL_DATA, sent().seq, CAL_DATA)
      await p
    }
    expect(written.map((b) => b[5]).includes(first)).toBe(true)
  })

  it('rejects a device speaking a different protocol version', async () => {
    const { link, sent, reply } = rig()
    const p = link.hello()
    reply(CAL_TYPE.HELLO_ACK, sent().seq, Uint8Array.of(2, 1, 8, 0, 1, 0))
    await expect(p).rejects.toThrow(/protocol 2/)
  })
})

describe('CalLink RAW handling', () => {
  it('routes RAW to the sample callback, never to a pending request', async () => {
    // RAW's SEQ is a free-running per-session counter, so it *will* eventually collide with a
    // request's SEQ. Matching it by SEQ would resolve that request with a RAW payload.
    const { link, raw, sent, reply } = rig()
    const p = link.getCal()
    const seq = sent().seq
    reply(CAL_TYPE.RAW, seq, Uint8Array.of(2, 0x83, 0x34, 0x00, 0x80))
    expect(raw).toEqual([{ idx: 2, raw: 13443, cal: 32768 }])

    let settled = false
    void p.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled, 'the colliding RAW must not have settled the request').toBe(false)

    reply(CAL_TYPE.CAL_DATA, seq, CAL_DATA)
    await expect(p).resolves.toBeDefined()
  })

  it('accepts RAW with no request outstanding', () => {
    const { link, raw } = rig()
    link.ingest(Buffer.from(buildFrame(CAL_TYPE.RAW, 7, Uint8Array.of(0, 1, 0, 2, 0))))
    expect(raw).toHaveLength(1)
  })
})

describe('CalLink export gate', () => {
  it('is shut while any exchange is in flight, including outside a session', async () => {
    // HELLO and GET_CAL are answered outside a session, so gating on session state alone would
    // race the badge refresh against the export stream.
    const { link, sent, reply } = rig()
    expect(link.exportGated).toBe(false)
    const p = link.hello()
    expect(link.exportGated).toBe(true)
    reply(CAL_TYPE.HELLO_ACK, sent().seq, HELLO_ACK)
    await p
    expect(link.exportGated).toBe(false)
  })

  it('stays shut for the whole session, between exchanges', async () => {
    const { link, sent, reply } = rig()
    const p = link.openSession(1)
    reply(CAL_TYPE.SESSION_ACK, sent().seq, Uint8Array.of(0x30, 0x75, 0, 0, 1))
    await p
    expect(link.exportGated).toBe(true)
    expect(link.inSession).toBe(true)
    expect(link.selectedAxis).toBe(1)

    const c = link.closeSession()
    reply(CAL_TYPE.ACK, sent().seq, Uint8Array.of(CAL_TYPE.SESSION_CLOSE))
    await c
    expect(link.exportGated).toBe(false)
  })

  it('leaves the session closed when SESSION_OPEN is refused', async () => {
    // The device NACKs a bad index and does not open. Assuming success from having *sent* the
    // request would leave us believing in a session the device does not have.
    const { link, sent, reply } = rig()
    const p = link.openSession(9)
    reply(CAL_TYPE.NACK, sent().seq, Uint8Array.of(CAL_TYPE.SESSION_OPEN, CAL_NACK.BAD_INDEX, 9))
    await expect(p).rejects.toBeInstanceOf(CalNackError)
    expect(link.inSession).toBe(false)
    expect(link.exportGated).toBe(false)
    expect(link.selectedAxis).toBe(CAL_AXIS_NONE)
  })
})

describe('CalLink passthrough', () => {
  it('hands non-frame bytes straight back', () => {
    const { link } = rig()
    expect(link.ingest(ascii('MASTER_CAUTION 1\n'))).toEqual(ascii('MASTER_CAUTION 1\n'))
  })

  it('removes a frame that landed mid-line, rejoining the line', () => {
    const { link } = rig()
    const f = Buffer.from(buildFrame(CAL_TYPE.RAW, 1, Uint8Array.of(0, 0, 0, 0, 0)))
    const out = link.ingest(Buffer.concat([ascii('MASTER_CA'), f, ascii('UTION 1\n')]))
    expect(out).toEqual(ascii('MASTER_CAUTION 1\n'))
  })
})

describe('CalLink timeouts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('times out when nothing answers', async () => {
    const { link } = rig()
    const p = link.hello()
    const settled = expect(p).rejects.toBeInstanceOf(CalTimeoutError)
    await vi.advanceTimersByTimeAsync(2000)
    await settled
  })

  it('sends KEEPALIVE while a session is open', async () => {
    const { link, written, sent, reply } = rig()
    const p = link.openSession(0)
    reply(CAL_TYPE.SESSION_ACK, sent().seq, Uint8Array.of(0x30, 0x75, 0, 0, 0))
    await p
    const before = written.length
    await vi.advanceTimersByTimeAsync(10_000)
    const ka = written.slice(before).filter((b) => b[4] === CAL_TYPE.KEEPALIVE)
    expect(ka).toHaveLength(1)
  })

  it('stops sending KEEPALIVE once the session closes', async () => {
    const { link, written, sent, reply } = rig()
    const open = link.openSession(0)
    reply(CAL_TYPE.SESSION_ACK, sent().seq, Uint8Array.of(0x30, 0x75, 0, 0, 0))
    await open
    const close = link.closeSession()
    reply(CAL_TYPE.ACK, sent().seq, Uint8Array.of(CAL_TYPE.SESSION_CLOSE))
    await close
    const before = written.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(written.slice(before).filter((b) => b[4] === CAL_TYPE.KEEPALIVE)).toHaveLength(0)
  })

  it('fails everything in flight when the port closes', async () => {
    const { link } = rig()
    const p = link.getCal()
    const settled = expect(p).rejects.toBeInstanceOf(CalTimeoutError)
    link.close()
    await settled
    expect(link.inSession).toBe(false)
  })

  it('releases held bytes on close, so a reconnect does not resume mid-candidate', () => {
    const { link } = rig()
    link.ingest(Buffer.from([0xaa, 0x53, 0x4b]))
    expect(link.close()).toEqual(Buffer.from([0xaa, 0x53, 0x4b]))
  })
})
