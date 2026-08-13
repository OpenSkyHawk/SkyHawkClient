// Calibration control channel over the SimGateway's CDC port (main process).
//
// Owns the request/response half of the protocol in FirmwarePlan/03-uart-usb-hid-protocol.md
// § Calibration Protocol (USB CDC). The codec itself is in @shared/calibration; this adds SEQ
// matching, timeouts, session upkeep, and the export-gate signal Session consumes.
//
// It does NOT own the serial port. Session does, and hands bytes in via ingest(); this returns
// what should carry on to DCS and the line assembler.
import {
  CAL_AXIS_NONE,
  CAL_NACK,
  CAL_PROTO_VERSION,
  CAL_TYPE,
  CalDemux,
  buildFrame,
  decodeAck,
  decodeCalData,
  decodeHelloAck,
  decodeNack,
  decodeRaw,
  decodeSessionAck,
  encodeCommit,
  encodeReset,
  type CalData,
  type CalFrame,
  type HelloAck,
  type RawSample
} from '@shared/calibration'
import { debugLog } from './debug'

/** Past the device's worst-case sector erase (~28 ms measured) by a wide margin. */
const REPLY_TIMEOUT_MS = 2000

/** The device closes an idle session after 30 s; a user reading a dialog step sends nothing. */
const KEEPALIVE_MS = 10_000

/** Names for the five NACK reasons that can actually reach us; see CAL_NACK in the codec. */
const NACK_NAME: Record<number, string> = {
  [CAL_NACK.BAD_INDEX]: 'BAD_INDEX',
  [CAL_NACK.BAD_ORDER]: 'BAD_ORDER',
  [CAL_NACK.NO_SESSION]: 'NO_SESSION',
  [CAL_NACK.NO_STORAGE]: 'NO_STORAGE',
  [CAL_NACK.BAD_DEADZONE]: 'BAD_DEADZONE'
}

/** The device answered and refused. Distinct from a timeout, and needs different messaging. */
export class CalNackError extends Error {
  constructor(
    readonly type: number,
    readonly reason: number,
    /** Axis index where one applies, else CAL_AXIS_NONE. */
    readonly detail: number
  ) {
    super(`calibration: device refused (${NACK_NAME[reason] ?? `reason 0x${reason.toString(16)}`})`)
    this.name = 'CalNackError'
  }
}

/**
 * No frame came back.
 *
 * Deliberately not "nothing was written": a timeout cannot separate "never received" from
 * "wrote it and the acknowledgement was lost", and with a ~28 ms erase against a 2 s deadline
 * the lost reply is the likelier of the two. Callers re-read with GET_CAL and report what the
 * device says rather than asserting an outcome.
 *
 * On HELLO specifically this is also how a protocol-version mismatch presents. The gateway
 * rejects an unknown type at its framing layer, where a failing candidate is relayed onward
 * rather than answered — so BAD_TYPE never reaches a client and silence is the only symptom.
 */
export class CalTimeoutError extends Error {
  constructor(readonly type: number) {
    super(`calibration: no reply within ${REPLY_TIMEOUT_MS} ms`)
    this.name = 'CalTimeoutError'
  }
}

interface Pending {
  type: number
  resolve: (f: CalFrame) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CalLink {
  private readonly demux = new CalDemux()
  private readonly pending = new Map<number, Pending>()
  private seq = 0
  private session = false
  private keepalive?: ReturnType<typeof setInterval>
  private streamAxis = CAL_AXIS_NONE

  constructor(
    private readonly write: (data: Buffer) => void,
    private readonly onRaw: (sample: RawSample) => void
  ) {}

  /**
   * True while the DCS export forward (PC -> device) must stay shut.
   *
   * Covers brief exchanges as well as whole sessions: the protocol's one rule is that the
   * client stops relaying before *any* exchange, a 10 ms HELLO as much as a calibration
   * session. HELLO and GET_CAL are answered outside a session, so gating only on `session`
   * would leave the badge refresh racing the export stream.
   */
  get exportGated(): boolean {
    return this.session || this.pending.size > 0
  }

  get inSession(): boolean {
    return this.session
  }

  /**
   * Feed inbound serial bytes; returns what should continue to DCS and the line assembler.
   *
   * Runs unconditionally, not only during a session — HELLO and GET_CAL are answered outside
   * one, so there is no point at which it is safe to stop looking. Anything that is not a valid
   * frame comes back out untouched.
   */
  ingest(chunk: Buffer): Buffer {
    const { frames, passthrough } = this.demux.push(chunk)
    for (const f of frames) this.dispatch(f)
    return Buffer.from(passthrough)
  }

  private dispatch(f: CalFrame): void {
    if (f.type === CAL_TYPE.RAW) {
      // Unsolicited, so never SEQ-matched: its SEQ is a free-running per-session counter, and
      // a gap in it means samples were dropped under back-pressure, not that the axis stopped.
      this.onRaw(decodeRaw(f.payload))
      return
    }
    const p = this.pending.get(f.seq)
    if (!p) {
      debugLog('cal.unmatched', { type: f.type, seq: f.seq })
      return
    }
    clearTimeout(p.timer)
    this.pending.delete(f.seq)
    if (f.type === CAL_TYPE.NACK) {
      const n = decodeNack(f.payload)
      p.reject(new CalNackError(n.type, n.reason, n.detail))
      return
    }
    p.resolve(f)
  }

  /** Next SEQ that is not already awaiting a reply. */
  private nextSeq(): number {
    for (let i = 0; i < 256; i++) {
      this.seq = (this.seq + 1) & 0xff
      if (!this.pending.has(this.seq)) return this.seq
    }
    throw new Error('calibration: no free sequence number')
  }

  /**
   * Send a pre-built frame and await its reply.
   *
   * Takes the frame rather than building it, because encodeCommit/encodeReset need the SEQ at
   * encode time — so the caller allocates it and passes both.
   *
   * One write() per frame: node-serialport queues writes FIFO, which is what stops the 5 s
   * node-roster request that shares this port from interleaving mid-frame.
   */
  private send(seq: number, type: number, frame: Uint8Array): Promise<CalFrame> {
    return new Promise<CalFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new CalTimeoutError(type))
      }, REPLY_TIMEOUT_MS)
      this.pending.set(seq, { type, resolve, reject, timer })
      this.write(Buffer.from(frame))
    })
  }

  private request(type: number, payload?: Uint8Array): Promise<CalFrame> {
    const seq = this.nextSeq()
    return this.send(seq, type, buildFrame(type, seq, payload))
  }

  /**
   * Identify the device.
   * @throws CalTimeoutError when nothing answers — no device, wrong firmware, or a protocol
   *         version this build cannot speak. The three are indistinguishable from here.
   */
  async hello(): Promise<HelloAck> {
    const f = await this.request(CAL_TYPE.HELLO)
    const ack = decodeHelloAck(f.payload)
    if (ack.proto !== CAL_PROTO_VERSION) {
      throw new Error(
        `calibration: device speaks protocol ${ack.proto}, this build speaks ${CAL_PROTO_VERSION}`
      )
    }
    return ack
  }

  /** Read stored calibration. Answered outside a session, which is what drives the badges. */
  async getCal(): Promise<CalData> {
    const f = await this.request(CAL_TYPE.GET_CAL)
    return decodeCalData(f.payload)
  }

  /**
   * Open a session and start RAW for one axis.
   *
   * The session is considered open only once SESSION_ACK arrives — a bad index is refused with
   * BAD_INDEX and leaves the device's session closed, so assuming success from having sent the
   * request would desynchronise us from the device.
   */
  async openSession(axisIdx: number): Promise<{ timeoutMs: number; axisIdx: number }> {
    const f = await this.request(CAL_TYPE.SESSION_OPEN, Uint8Array.of(axisIdx))
    const ack = decodeSessionAck(f.payload)
    this.session = true
    this.streamAxis = ack.axisIdx
    this.startKeepalive()
    return ack
  }

  /** Change which axis streams. Requires an open session. */
  async streamSelect(axisIdx: number): Promise<void> {
    await this.request(CAL_TYPE.STREAM_SELECT, Uint8Array.of(axisIdx))
    this.streamAxis = axisIdx
  }

  get selectedAxis(): number {
    return this.streamAxis
  }

  /**
   * Write one axis and persist it. Exactly one axis per COMMIT.
   *
   * Resolving means the device acknowledged receipt. It does not mean "stored" — callers verify
   * with getCal(), because an acknowledgement and a successful flash write are different claims.
   */
  async commit(axis: { idx: number; min: number; centre: number; max: number }): Promise<void> {
    const seq = this.nextSeq()
    const frame = encodeCommit(seq, axis)
    await this.send(seq, CAL_TYPE.COMMIT, frame)
  }

  /**
   * Delete stored calibration for one axis, or all with CAL_AXIS_NONE.
   *
   * Persists immediately through the same flash write as COMMIT, so it fails the same ways —
   * NO_STORAGE, or a timeout. It is not a "restore defaults"; the axis reverts to identity
   * passthrough.
   */
  async reset(idx: number): Promise<void> {
    const seq = this.nextSeq()
    await this.send(seq, CAL_TYPE.RESET, encodeReset(seq, idx))
  }

  async closeSession(): Promise<void> {
    this.stopKeepalive()
    this.session = false
    this.streamAxis = CAL_AXIS_NONE
    await this.request(CAL_TYPE.SESSION_CLOSE)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepalive = setInterval(() => {
      // Any accepted frame refreshes the device's timer, so this only matters across stretches
      // where the user is reading rather than acting. A failure here is not worth surfacing.
      this.request(CAL_TYPE.KEEPALIVE).catch((e: Error) => debugLog('cal.keepalive', e.message))
    }, KEEPALIVE_MS)
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
  }

  /**
   * Port closed. Fail everything in flight and release held bytes — a reconnect must not start
   * mid-candidate, and a caller awaiting a reply that can never arrive would hang.
   *
   * The device's own session expires 30 s later on its side. Because the outbound direction was
   * never taken over, that degrades to exactly normal operation; only RAW streaming stops.
   */
  close(): Buffer {
    this.stopKeepalive()
    this.session = false
    this.streamAxis = CAL_AXIS_NONE
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new CalTimeoutError(p.type))
    }
    this.pending.clear()
    return Buffer.from(this.demux.flush())
  }

  /** Acknowledged type, for tests and diagnostics. */
  static ackType(f: CalFrame): number {
    return decodeAck(f.payload).type
  }
}
