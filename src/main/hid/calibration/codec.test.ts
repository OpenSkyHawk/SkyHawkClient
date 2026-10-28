import { describe, expect, it } from 'vitest'
import {
  AXIS_CAL_SLOTS,
  CAL_AXIS_NONE,
  CAL_MAGIC,
  CAL_MAX_FRAME,
  CAL_PAYLOAD_LEN,
  CAL_TYPE,
  CalDemux,
  buildFrame,
  crc16,
  decodeCalData,
  decodeDiag,
  decodeHelloAck,
  decodeNack,
  decodeRaw,
  decodeSessionAck,
  diagWidths,
  CAL_DIAG_WIDTH,
  encodeCommit,
  encodeHello,
  encodeReset,
  encodeSessionOpen,
  nackName
} from './codec'
import {
  CAL_DIAG_BYTES,
  CAL_DIAG_FIELD,
  CAL_DIAG_RESET_REASONS,
  CAL_NACK_REASONS,
  CAL_PROTO
} from '@shared/firmware'
import { diagPayload, type DiagFieldName } from '../../../test-fixtures/diag'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** Deterministic LCG — a seeded stream keeps a property failure reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('crc16', () => {
  it('matches the CCITT-FALSE canonical check vector', () => {
    expect(crc16(ascii('123456789'))).toBe(0x29b1)
  })

  it('is initialised to 0xFFFF, so leading zeros change the result', () => {
    // A 0x0000 init could not tell an all-zero buffer from a shorter all-zero one.
    expect(crc16(new Uint8Array(2))).not.toBe(crc16(new Uint8Array(4)))
  })

  it('is empty-safe', () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff)
  })
})

// Captured from the Python reference implementation that drove the successful end-to-end run
// against real hardware. These pin the codec to bytes a device has already accepted, rather
// than to itself — a self-consistent CRC or coverage error would survive every other test here.
describe('golden vectors from the proven bench implementation', () => {
  it('HELLO seq=1', () => {
    expect(encodeHello(1)).toEqual(hex('aa534b430101000044c5'))
  })

  it('SESSION_OPEN seq=7 axis=0', () => {
    expect(encodeSessionOpen(7, 0)).toEqual(hex('aa534b430307010000c399'))
  })

  it('COMMIT seq=9 — the measured AxisBench Roll endpoints', () => {
    expect(encodeCommit(9, { idx: 0, min: 13443, centre: 34728, max: 50704 })).toEqual(
      hex('aa534b4305090900008334a88710c60000f981')
    )
  })
})

describe('buildFrame', () => {
  it('excludes the magic from CRC coverage', () => {
    const f = buildFrame(CAL_TYPE.ACK, 0x11, Uint8Array.from([CAL_TYPE.COMMIT]))
    const stored = f[f.length - 2]! | (f[f.length - 1]! << 8)
    expect(crc16(f.subarray(4, f.length - 2))).toBe(stored)
    // ...and covering the magic too would give a different answer, so the test can tell.
    expect(crc16(f.subarray(0, f.length - 2))).not.toBe(stored)
  })

  it('refuses a payload that is not the type’s one legal length', () => {
    expect(() => buildFrame(CAL_TYPE.COMMIT, 0, new Uint8Array(8))).toThrow(/exactly 9/)
    expect(() => buildFrame(CAL_TYPE.HELLO, 0, new Uint8Array(1))).toThrow(/exactly 0/)
  })

  it('refuses an unknown type', () => {
    expect(() => buildFrame(0x7f, 0)).toThrow(/unknown frame type/)
  })
})

describe('CalDemux', () => {
  const d = () => new CalDemux()
  const frameOf = (type: number, seq = 0) =>
    buildFrame(type, seq, new Uint8Array(CAL_PAYLOAD_LEN[type]!))

  it('round-trips every message type that fits the carry (all but UPL_DATA, client-only)', () => {
    for (const [name, type] of Object.entries(CAL_TYPE)) {
      if (CAL_PROTO.envelopeBytes + CAL_PAYLOAD_LEN[type]! > CAL_MAX_FRAME) continue
      const payload = Uint8Array.from(
        { length: CAL_PAYLOAD_LEN[type]! },
        (_, i) => (i * 7 + 3) & 0xff
      )
      const { frames, passthrough } = d().push(buildFrame(type, 0x5a, payload))
      expect(frames, name).toHaveLength(1)
      expect(frames[0]!.type, name).toBe(type)
      expect(frames[0]!.seq, name).toBe(0x5a)
      expect(frames[0]!.payload, name).toEqual(payload)
      expect(passthrough, name).toHaveLength(0)
    }
  })

  it('reassembles a frame split at every possible boundary', () => {
    const frame = buildFrame(CAL_TYPE.RAW, 9, Uint8Array.from([2, 0x34, 0x12, 0x78, 0x56]))
    for (let k = 0; k <= frame.length; k++) {
      const x = d()
      const a = x.push(frame.subarray(0, k))
      const b = x.push(frame.subarray(k))
      expect([...a.frames, ...b.frames], `split at ${k}`).toHaveLength(1)
      expect(cat(a.passthrough, b.passthrough, x.flush()), `split at ${k}`).toHaveLength(0)
    }
  })

  it('reassembles a frame delivered one byte at a time', () => {
    const frame = buildFrame(CAL_TYPE.SESSION_ACK, 3, hex('30750000ff'))
    const x = d()
    const got = []
    for (const b of frame) got.push(...x.push(Uint8Array.of(b)).frames)
    expect(got).toHaveLength(1)
    expect(decodeSessionAck(got[0]!.payload)).toEqual({ timeoutMs: 30000, axisIdx: CAL_AXIS_NONE })
  })

  it('extracts a frame injected mid-line and rejoins the DCS text around it', () => {
    const frame = frameOf(CAL_TYPE.ACK)
    const { frames, passthrough } = d().push(cat(ascii('MASTER_CAU'), frame, ascii('TION 1\n')))
    expect(frames).toHaveLength(1)
    expect(passthrough).toEqual(ascii('MASTER_CAUTION 1\n'))
  })

  it('passes a DCS-BIOS export sync through byte-identical', () => {
    const sync = hex('55555555001002000100')
    const { frames, passthrough } = d().push(sync)
    expect(frames).toHaveLength(0)
    expect(passthrough).toEqual(sync)
  })

  it('passes a bare 0xAA through — the gateway emits one on parser resync', () => {
    const chunk = cat(ascii('LINE '), Uint8Array.of(0xaa), ascii(' MORE\n'))
    const x = d()
    // 0xAA at the end of a chunk is held as a possible prefix, then resolved by the next byte.
    expect(cat(x.push(chunk).passthrough, x.flush())).toEqual(chunk)
  })

  it('re-emits every byte of a CRC failure', () => {
    const bad = frameOf(CAL_TYPE.HELLO_ACK)
    bad[bad.length - 1]! ^= 0xff
    const x = d()
    const { frames, passthrough } = x.push(bad)
    expect(frames).toHaveLength(0)
    expect(cat(passthrough, x.flush())).toEqual(bad)
  })

  it('rejects a LEN that is not the type’s, without buffering the payload', () => {
    // A stray magic in DCS-BIOS text decoding LEN ~65535. The reject must happen on the length
    // comparison, not after waiting for 65535 bytes — that is the whole reason LEN is fixed.
    const evil = cat(CAL_MAGIC, Uint8Array.of(CAL_TYPE.HELLO, 0x00, 0xff, 0xff), ascii('tail\n'))
    const x = d()
    const { frames, passthrough } = x.push(evil)
    // Read pending BEFORE flushing — flush() clears the carry, which would make this vacuous.
    expect(x.pending, 'nothing may be held for a length that was never legal').toBe(0)
    expect(frames).toHaveLength(0)
    expect(cat(passthrough, x.flush())).toEqual(evil)
  })

  it('rejects an off-by-one LEN on a fixed-length type', () => {
    const f = frameOf(CAL_TYPE.RESET)
    f[6] = 2 // RESET is 1
    const x = d()
    expect(x.push(f).frames).toHaveLength(0)
    expect(x.pending).toBe(0)
  })

  it('never holds more than one maximal frame', () => {
    const x = d()
    // A CAL_DATA header promising 82 bytes, with the payload withheld.
    x.push(cat(CAL_MAGIC, Uint8Array.of(CAL_TYPE.CAL_DATA, 0, 82, 0), new Uint8Array(40)))
    expect(x.pending).toBeGreaterThan(0)
    expect(x.pending).toBeLessThanOrEqual(CAL_MAX_FRAME)
  })

  it('a frame larger than the device ever sends is never held (UPL_DATA, 260 bytes)', () => {
    const x = d()
    const UPL_DATA = 0x12 // client -> device only; larger than any frame the device sends
    expect(CAL_PAYLOAD_LEN[UPL_DATA]).toBeGreaterThan(CAL_MAX_FRAME)
    const r = x.push(cat(CAL_MAGIC, Uint8Array.of(UPL_DATA, 0, 0x04, 0x01), new Uint8Array(40)))
    expect(r.frames).toHaveLength(0)
    expect(x.pending).toBe(0)
  })

  it('flush releases held bytes and clears the carry', () => {
    const x = d()
    x.push(CAL_MAGIC.subarray(0, 3))
    expect(x.pending).toBe(3)
    expect(x.flush()).toEqual(CAL_MAGIC.subarray(0, 3))
    expect(x.pending).toBe(0)
    expect(x.flush()).toHaveLength(0)
  })

  it('recovers when a false magic is immediately followed by a real frame', () => {
    const real = frameOf(CAL_TYPE.KEEPALIVE)
    const noise = cat(CAL_MAGIC.subarray(0, 3), Uint8Array.of(0x00))
    const x = d()
    const { frames, passthrough } = x.push(cat(noise, real))
    expect(frames).toHaveLength(1)
    expect(cat(passthrough, x.flush())).toEqual(noise)
  })
})

// The assertion that actually protects the DCS stream. Stated as removal rather than
// concatenation: push() returns frames and passthrough in separate collections with no source
// offsets, so "passthrough ++ frame bytes === input" is unsatisfiable by any correct
// implementation — TEXT1 FRAME TEXT2 yields TEXT1+TEXT2 and [FRAME], which no ordering
// reassembles. The test builds the input, so it knows every frame's range.
describe('passthrough completeness', () => {
  const TYPES = Object.values(CAL_TYPE).filter(
    (t) => CAL_PROTO.envelopeBytes + CAL_PAYLOAD_LEN[t]! <= CAL_MAX_FRAME
  )

  it('passthrough equals the input with accepted frame ranges removed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed)
      const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!

      const parts: Uint8Array[] = []
      const expectFrames: Uint8Array[] = []
      const expectPass: number[] = []

      for (let n = 0; n < 12; n++) {
        if (rand() < 0.45) {
          const type = pick(TYPES)
          const f = buildFrame(
            type,
            Math.floor(rand() * 256),
            Uint8Array.from({ length: CAL_PAYLOAD_LEN[type]! }, () => Math.floor(rand() * 256))
          )
          parts.push(f)
          expectFrames.push(f)
        } else {
          // Filler deliberately includes 0xAA and partial magics — the nasty cases.
          const junk = Uint8Array.from({ length: 1 + Math.floor(rand() * 24) }, () =>
            rand() < 0.2 ? pick([0xaa, 0x53, 0x4b, 0x43, 0x55]) : 0x20 + Math.floor(rand() * 90)
          )
          parts.push(junk)
          expectPass.push(...junk)
        }
      }

      const input = cat(...parts)
      const x = new CalDemux()
      const gotFrames = []
      const gotPass: number[] = []
      let off = 0
      while (off < input.length) {
        const size = 1 + Math.floor(rand() * 37)
        const r = x.push(input.subarray(off, Math.min(off + size, input.length)))
        gotFrames.push(...r.frames)
        gotPass.push(...r.passthrough)
        off += size
      }
      gotPass.push(...x.flush())

      expect(
        gotFrames.map((f) => f.type),
        `seed ${seed}`
      ).toEqual(expectFrames.map((f) => f[4]))
      expect(Uint8Array.from(gotPass), `seed ${seed}`).toEqual(Uint8Array.from(expectPass))
    }
  })

  it('a rejected candidate reaches passthrough complete and unchanged', () => {
    // Not a frame, so every byte of it belongs to the DCS stream — including the magic.
    const corrupt = buildFrame(CAL_TYPE.NACK, 4, hex('050501'))
    corrupt[9]! ^= 0x01 // flip a payload bit, breaking the CRC
    const x = new CalDemux()
    const { frames, passthrough } = x.push(cat(ascii('A'), corrupt, ascii('B')))
    expect(frames).toHaveLength(0)
    expect(cat(passthrough, x.flush())).toEqual(cat(ascii('A'), corrupt, ascii('B')))
  })
})

describe('decoders', () => {
  it('decodes HELLO_ACK', () => {
    expect(decodeHelloAck(hex('010108000100'))).toEqual({
      proto: 1,
      blobVersion: 1,
      axisSlots: 8,
      fw: { major: 0, minor: 1, patch: 0 }
    })
  })

  it('decodes NACK', () => {
    expect(decodeNack(hex('050503'))).toEqual({ type: CAL_TYPE.COMMIT, reason: 0x05, detail: 3 })
  })

  it('names every NACK reason the firmware table lists, and an unknown one as `Unknown reason (0xNN)` (X11, #183, #190)', () => {
    // One name for the refusal message and the failure's reasonName, from the synced table: the
    // calibration reasons, the three the framing layer stops, and the firmware-upload ones alike.
    const named = Object.keys(CAL_NACK_REASONS).map((k) => [Number(k), nackName(Number(k))])
    expect(named).toEqual([
      [0x1, 'BAD_CRC'],
      [0x2, 'BAD_LENGTH'],
      [0x3, 'BAD_TYPE'],
      [0x4, 'BAD_INDEX'],
      [0x5, 'BAD_ORDER'],
      [0x6, 'NO_SESSION'],
      [0x7, 'NO_STORAGE'],
      [0x8, 'BAD_DEADZONE'],
      [0x9, 'BUSY'],
      [0xa, 'TOO_LARGE'],
      [0xb, 'BAD_OFFSET'],
      [0xc, 'IMAGE_CRC'],
      [0xd, 'BAD_IMAGE'],
      [0xe, 'NOT_STAGED']
    ])
    expect(nackName(0xf)).toBe('Unknown reason (0x0F)')
    expect(nackName(0x0)).toBe('Unknown reason (0x00)')
    expect(nackName(0xff)).toBe('Unknown reason (0xFF)')
  })

  it('decodes RAW, keeping raw and cal distinct — and both unsigned', () => {
    // One convention across the whole channel. If a conversion is ever added for `cal` alone,
    // this fails: the offset applied to some values and not others is the silent-failure case,
    // and endpoints would then be displayed in units other than the ones committed.
    expect(decodeRaw(hex('0283340080'))).toEqual({ idx: 2, raw: 13443, cal: 32768 })
  })

  it('leaves CAL_DATA endpoints exactly as committed', () => {
    // Endpoints are positions in ADC space and are what COMMIT stores, so the numbers decoded
    // here are the bytes written to flash — no re-basing between what is shown and what is sent.
    const p = new Uint8Array(82)
    p[0] = 0b1
    const put = (o: number, v: number) => {
      p[o] = v & 0xff
      p[o + 1] = (v >> 8) & 0xff
    }
    put(4, 13443)
    put(6, 34728)
    put(8, 50704)
    const a = decodeCalData(p).axes[0]!
    expect([a.min, a.centre, a.max]).toEqual([13443, 34728, 50704])
  })

  it('decodes CAL_DATA masks and all eight slots', () => {
    const p = new Uint8Array(82)
    p[0] = 0b0000_0101 // axes 0 and 2 declared
    p[1] = 0b0000_0100 // only axis 2 calibrated
    const put = (o: number, v: number) => {
      p[o] = v & 0xff
      p[o + 1] = (v >> 8) & 0xff
    }
    put(2, 0x0010) // axis 0 controlId = CTRL_ROLL
    const o2 = 2 + 2 * 10
    put(o2, 0x0012)
    put(o2 + 2, 13443)
    put(o2 + 4, 34728)
    put(o2 + 6, 50704)

    const cal = decodeCalData(p)
    expect(cal.axes).toHaveLength(AXIS_CAL_SLOTS)
    expect(cal.axes.filter((a) => a.present).map((a) => a.idx)).toEqual([0, 2])
    expect(cal.axes.filter((a) => a.calibrated).map((a) => a.idx)).toEqual([2])
    expect(cal.axes[0]!.controlId).toBe(0x0010)
    expect(cal.axes[2]).toMatchObject({
      controlId: 0x0012,
      min: 13443,
      centre: 34728,
      max: 50704,
      deadzone: 0
    })
    // An absent slot carries controlId 0 and zeroed endpoints, not junk.
    expect(cal.axes[7]).toMatchObject({ controlId: 0, min: 0, centre: 0, max: 0 })
  })
})

describe('decodeDiag (#169)', () => {
  const diag = diagPayload
  /** Every field this client reads, by its CalDiagField name. */
  const FIELDS = Object.keys(CAL_DIAG_WIDTH) as DiagFieldName[]
  /** The largest value a field of this width holds: what a saturated counter reads. */
  const full = (f: DiagFieldName) => 2 ** (8 * CAL_DIAG_WIDTH[f]) - 1

  it('decodes every field at its offset, little-endian', () => {
    const p = diag({
      UPTIME_MS: 3_600_000,
      FIRST_UART_ERR_MS: 1000,
      LAST_UART_ERR_MS: 2000,
      FIRST_USB_LOSS_MS: 3000,
      LAST_USB_LOSS_MS: 4000,
      UART_OVERRUN: 1,
      UART_FRAMING: 2,
      UART_BREAK: 3,
      UART_PARITY: 4,
      UART_RX_OVERFLOW: 5,
      LINES_DROPPED: 6,
      LINES_CORRUPT: 7,
      LINES_OVERLONG: 8,
      FRAMES_DROPPED: 9,
      UART_RESTARTS: 10,
      USB_REATTACHES: 11,
      CDC_STALLS: 12,
      RECOVERY_REBOOTS: 13,
      WATCHDOG_RESETS: 14,
      RESET_REASON: CAL_DIAG_RESET_REASONS.RECOVERY
    })
    expect(decodeDiag(p)).toEqual({
      uptimeMs: 3_600_000,
      firstUartErrMs: 1000,
      lastUartErrMs: 2000,
      firstUsbLossMs: 3000,
      lastUsbLossMs: 4000,
      uartOverrun: 1,
      uartFraming: 2,
      uartBreak: 3,
      uartParity: 4,
      uartRxOverflow: 5,
      linesDropped: 6,
      linesCorrupt: 7,
      linesOverlong: 8,
      framesDropped: 9,
      uartRestarts: 10,
      usbReattaches: 11,
      cdcStalls: 12,
      recoveryReboots: 13,
      watchdogResets: 14,
      resetReason: CAL_DIAG_RESET_REASONS.RECOVERY
    })
  })

  it('codec.diag-widths: each field it reads runs to the next offset and is read at that width', () => {
    // The fields it reads tile the record from 0 with no gap and no overlap, and end at or before
    // RESERVED: a counter a later firmware adds there is no field this client reads.
    const tiled = FIELDS.map((f) => [CAL_DIAG_FIELD[f], CAL_DIAG_WIDTH[f]] as const).sort(
      (a, b) => a[0] - b[0]
    )
    let end = 0
    for (const [at, width] of tiled) {
      expect(at).toBe(end)
      end = at + width
    }
    expect(end).toBeLessThanOrEqual(CAL_DIAG_FIELD.RESERVED)
    // A field with every byte of its width set reads as its largest value, and spills into no
    // other field: the decoder reads exactly the derived width.
    const all = decodeDiag(diag())
    for (const f of FIELDS) {
      const d = decodeDiag(diag({ [f]: full(f) }))
      const changed = (Object.keys(d) as (keyof typeof d)[]).filter((k) => d[k] !== all[k])
      expect(changed, f).toHaveLength(1)
      expect(d[changed[0]!], f).toBe(full(f))
    }
  })

  it('diagWidths: each field to the next offset; a layout must end at RESERVED', () => {
    expect(diagWidths({ A: 0, B: 4, RESERVED: 7 })).toEqual({ A: 4, B: 3 })
    expect(() => diagWidths({ A: 0, RESERVED: 2, B: 4 })).toThrow(/end at RESERVED/)
  })

  it('times of 0 mean never; an uptime past 2^31 ms stays unsigned', () => {
    const d = decodeDiag(diag({ UPTIME_MS: full('UPTIME_MS') - 0xf }))
    expect(d.uptimeMs).toBe(full('UPTIME_MS') - 0xf) // ~49.7 days, not a negative number
    expect([d.firstUartErrMs, d.lastUartErrMs, d.firstUsbLossMs, d.lastUsbLossMs]).toEqual([
      0, 0, 0, 0
    ])
  })

  it("saturated counters read their width's largest value", () => {
    const sat = ['LINES_DROPPED', 'CDC_STALLS', 'RECOVERY_REBOOTS', 'WATCHDOG_RESETS'] as const
    const d = decodeDiag(diag(Object.fromEntries(sat.map((f) => [f, full(f)]))))
    expect([d.linesDropped, d.cdcStalls, d.recoveryReboots, d.watchdogResets]).toEqual(
      sat.map(full)
    )
  })

  it('keeps every reset reason raw, a newer one too', () => {
    const newer = Math.max(...Object.values(CAL_DIAG_RESET_REASONS)) + 1
    for (const r of [...Object.values(CAL_DIAG_RESET_REASONS), newer]) {
      expect(decodeDiag(diag({ RESET_REASON: r })).resetReason).toBe(r)
    }
  })

  it('ignores the reserved bytes, so a later counter there changes nothing it reads', () => {
    const p = diag({ UPTIME_MS: 5 })
    const q = p.slice()
    q.fill(0xab, CAL_DIAG_FIELD.RESERVED)
    expect(decodeDiag(q)).toEqual(decodeDiag(p))
  })

  it('rejects any length but CAL_DIAG_BYTES, the pre-#359 one (up to RESERVED) too', () => {
    const want = new RegExp(String(CAL_DIAG_BYTES))
    expect(() => decodeDiag(new Uint8Array(CAL_DIAG_FIELD.RESERVED))).toThrow(want)
    expect(() => decodeDiag(new Uint8Array(CAL_DIAG_BYTES + 1))).toThrow(want)
  })

  it('a DIAG frame passes the demux whole; it fits the carry', () => {
    const x = new CalDemux()
    const r = x.push(buildFrame(CAL_TYPE.DIAG, 3, diag({ UPTIME_MS: 7 })))
    expect(r.frames).toHaveLength(1)
    expect(decodeDiag(r.frames[0]!.payload).uptimeMs).toBe(7)
  })

  it('codec.diag-047: a firmware 0.2.0 DIAG (the bytes up to RESERVED) on the wire is not a frame', () => {
    // 0.2.0 sent DIAG without the reserved tail. Its envelope is well formed, but LEN doesn't
    // match the type, so the demux hands every byte back to the stream and no reply arrives.
    const payload = diag({ UPTIME_MS: 7 }).slice(0, CAL_DIAG_FIELD.RESERVED)
    const body = Uint8Array.of(
      CAL_TYPE.DIAG,
      3,
      payload.length & 0xff,
      payload.length >> 8,
      ...payload
    )
    const c = crc16(body)
    const wire = cat(CAL_MAGIC, body, Uint8Array.of(c & 0xff, c >> 8))
    const x = new CalDemux()
    const r = x.push(wire)
    expect(r.frames).toEqual([])
    expect(cat(r.passthrough, x.flush())).toEqual(wire)
  })
})

describe('encoders', () => {
  it('forces deadzone to zero — a non-zero value is refused with BAD_DEADZONE', () => {
    const f = encodeCommit(1, { idx: 3, min: 100, centre: 300, max: 500 })
    expect(f.subarray(15, 17)).toEqual(Uint8Array.of(0, 0))
  })

  it('encodes RESET-all with the axis sentinel', () => {
    const { frames } = new CalDemux().push(encodeReset(2, CAL_AXIS_NONE))
    expect(frames[0]!.payload).toEqual(Uint8Array.of(0xff))
  })
})
