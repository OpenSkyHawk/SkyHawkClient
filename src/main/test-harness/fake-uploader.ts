// A simulated Gateway uploader (test-only: production code never imports this), at the wire: it
// reads the calibration-channel frames the client writes and answers with the frames the Gateway
// would, following OpenSkyhawk firmware-v0.3.0 Firmware/Libraries/SimGateway/Uploader.cpp and
// SimGateway.cpp's calibration gating (#366, #367). The bench client
// Firmware/Bootloader/tools/upload_gateway.py is the reference the client is checked against.
//
// What it models: the states (idle, staging, staged, flashing); the bundled cockpit-side image for
// target 0; BUSY while a calibration session is open; each flash's phases, retries and result,
// scripted per test; the 5 s "client gone" silence (status and result withheld, the result still
// kept for UPL_INFO_ACK); the 30 s staged-image drop; and a power cycle of the USB side (its RAM,
// the session and the last result, lost).
//
// Its timings are the firmware's own (Uploader.cpp's anonymous constants, not synced): a fake of
// the device, not client policy.
import {
  BOOT,
  CAL_PAYLOAD_LEN,
  CAL_PROTO,
  UPL_INFO_ACK_FIELD as INFO,
  UPL_PHASE,
  UPL_PROTO,
  UPL_RESULT,
  UPL_RESULT_FIELD as RESULT,
  UPL_STATE,
  UPL_STATUS_FIELD as STATUS,
  UPL_TARGET,
  type CalNackName,
  type UplPhaseName,
  type UplResultName
} from '@shared/firmware'
import { CAL_NACK, buildFrame, crc16 } from '../hid/calibration/codec'
import { imageCrc32, parseIdentity } from '../update/firmware-image'
import { UPL_TYPE } from '../update/uploader/upl-codec'

/** Uploader.cpp SESSION_IDLE_MS: staging / staged with no client frame this long → dropped. */
export const FAKE_SESSION_IDLE_MS = 30_000
/** Uploader.cpp CLIENT_GONE_MS: no client frame this long → no more UPL_STATUS / UPL_RESULT. */
export const FAKE_CLIENT_GONE_MS = 5_000

/** One UPL_STATUS of a scripted flash. */
export interface FlashStep {
  phase: UplPhaseName
  attempt?: number
  /** WRITING's blocks acknowledged so far; 0 elsewhere. */
  block?: number
}

/** How the next flash goes: its steps, its result and the version the board then reports. */
export interface FlashScript {
  steps?: FlashStep[]
  result?: UplResultName
  /** The version reported (OK, VERSION_MISMATCH); default: the image's own. */
  reports?: string
}

type Frame = { type: number; seq: number; payload: Uint8Array }

const ver = (v: string): [number, number, number] => {
  const [a, b, c] = v.split('.').map(Number)
  return [a ?? 0, b ?? 0, c ?? 0]
}

/** The phases of a whole flash, writing `blocks` in four steps, on attempt `attempt`. */
export function flashSteps(blocks: number, attempt = 0): FlashStep[] {
  const w = (n: number): FlashStep => ({ phase: 'WRITING', attempt, block: Math.round(blocks * n) })
  return [
    { phase: 'ENTERING_BOOT', attempt },
    { phase: 'CONNECTED', attempt },
    { phase: 'ERASING', attempt },
    w(0.25),
    w(0.5),
    w(0.75),
    w(1),
    { phase: 'VERIFYING', attempt },
    { phase: 'REBOOTING', attempt },
    { phase: 'CONFIRMING', attempt }
  ]
}

export class FakeUploader {
  state: number = UPL_STATE.IDLE
  /** A calibration session is open: UPL_BEGIN / UPL_FLASH answer BUSY. */
  calibrationSession = false
  /** The next flash's script; consumed when it starts. */
  next: FlashScript = {}
  /** How long each scripted step takes. */
  stepMs = 100
  /** Every request the client sent, by type, in order (KEEPALIVE included). */
  readonly requests: number[] = []

  private img = new Uint8Array(UPL_PROTO.maxImageBytes)
  private len = 0
  private crc = 0
  private lastClientMs = -Infinity
  private lastTarget = 0
  private lastResult: number = UPL_RESULT.NONE
  private lastFw: [number, number, number] = [0, 0, 0]
  private timers: ReturnType<typeof setTimeout>[] = []
  private rx = new Uint8Array(0)

  constructor(
    /** Bytes the Gateway sends to the client. */
    private readonly send: (bytes: Uint8Array) => void,
    /** The cockpit-side image this Gateway firmware carries (#367); none = a build without it. */
    private readonly bundle?: Uint8Array
  ) {}

  /** The USB side lost power: everything the uploader held was in RAM. */
  powerCycle(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.state = UPL_STATE.IDLE
    this.len = 0
    this.lastClientMs = -Infinity
    this.lastTarget = 0
    this.lastResult = UPL_RESULT.NONE
    this.lastFw = [0, 0, 0]
    this.rx = new Uint8Array(0)
  }

  /** Bytes the client wrote. Frames are answered; anything else is ignored. */
  receive(bytes: Uint8Array): void {
    const buf = new Uint8Array(this.rx.length + bytes.length)
    buf.set(this.rx)
    buf.set(bytes, this.rx.length)
    let i = 0
    for (;;) {
      const at = buf.indexOf(CAL_PROTO.magic[0], i)
      if (at < 0 || buf.length - at < CAL_PROTO.envelopeBytes) {
        this.rx = at < 0 ? new Uint8Array(0) : buf.slice(at)
        return
      }
      const magic = CAL_PROTO.magic.every((m, k) => buf[at + k] === m)
      const type = buf[at + 4]!
      const len = buf[at + 6]! | (buf[at + 7]! << 8)
      if (!magic || CAL_PAYLOAD_LEN[type] !== len) {
        i = at + 1
        continue
      }
      const total = CAL_PROTO.envelopeBytes + len
      if (buf.length - at < total) {
        this.rx = buf.slice(at)
        return
      }
      const want = buf[at + 8 + len]! | (buf[at + 9 + len]! << 8)
      if (crc16(buf.subarray(at + 4, at + 8 + len)) === want) {
        this.frame({ type, seq: buf[at + 5]!, payload: buf.slice(at + 8, at + 8 + len) })
      }
      i = at + total
    }
  }

  // ── the uploader ────────────────────────────────────────────────────────────

  private frame(f: Frame): void {
    const now = Date.now()
    this.requests.push(f.type)
    // The 30 s drop runs on the Gateway's own clock; checked here, when the next frame comes.
    if (
      (this.state === UPL_STATE.STAGING || this.state === UPL_STATE.STAGED) &&
      now - this.lastClientMs >= FAKE_SESSION_IDLE_MS
    ) {
      this.state = UPL_STATE.IDLE
    }
    this.lastClientMs = now
    const T = UPL_TYPE
    if (this.calibrationSession && (f.type === T.UPL_BEGIN || f.type === T.UPL_FLASH)) {
      return this.nack(f, 'BUSY')
    }
    switch (f.type) {
      case T.KEEPALIVE:
        return this.ack(f)
      case T.UPL_INFO:
        return this.reply(T.UPL_INFO_ACK, f.seq, this.infoAck())
      case T.UPL_BEGIN: {
        if (this.state === UPL_STATE.FLASHING) return this.nack(f, 'BUSY')
        const n = u32(f.payload, 0)
        if (!n || n > UPL_PROTO.maxImageBytes || n & 3) return this.nack(f, 'TOO_LARGE')
        this.len = n
        this.crc = u32(f.payload, 4)
        this.img.fill(0xff)
        this.state = UPL_STATE.STAGING
        return this.ack(f)
      }
      case T.UPL_DATA: {
        if (this.state !== UPL_STATE.STAGING) return this.nack(f, 'NO_SESSION')
        const off = u32(f.payload, 0)
        if (off % UPL_PROTO.chunkBytes || off >= this.len) return this.nack(f, 'BAD_OFFSET')
        this.img.set(
          f.payload.subarray(4, 4 + Math.min(UPL_PROTO.chunkBytes, this.img.length - off)),
          off
        )
        return this.ack(f)
      }
      case T.UPL_END: {
        if (this.state !== UPL_STATE.STAGING) return this.nack(f, 'NO_SESSION')
        if (imageCrc32(this.img, this.len) !== this.crc) return this.nack(f, 'IMAGE_CRC')
        const id = parseIdentity(this.img.subarray(0, this.len))
        if (!id.ok || id.id.imageLength !== this.len) return this.nack(f, 'BAD_IMAGE')
        this.state = UPL_STATE.STAGED
        return this.ack(f)
      }
      case T.UPL_FLASH: {
        const target = f.payload[0]!
        if (target === UPL_TARGET.bridge && this.state === UPL_STATE.IDLE) {
          if (!this.bundle) return this.nack(f, 'NOT_STAGED')
          const id = parseIdentity(this.bundle)
          if (!id.ok) throw new Error('fake uploader: the bundle has no identity block')
          this.img.fill(0xff)
          this.img.set(this.bundle.subarray(0, id.id.imageLength))
          this.len = id.id.imageLength
          this.crc = id.id.imageCrc
          this.state = UPL_STATE.STAGED
        }
        if (this.state === UPL_STATE.IDLE) return this.nack(f, 'NO_SESSION')
        if (this.state === UPL_STATE.FLASHING) return this.nack(f, 'BUSY')
        if (this.state !== UPL_STATE.STAGED) return this.nack(f, 'NOT_STAGED')
        if (target !== UPL_TARGET.unconfigured && target > 63)
          return this.nack(f, 'BAD_INDEX', target)
        this.ack(f)
        return this.startFlash(target)
      }
      case T.UPL_ABORT:
        if (this.state === UPL_STATE.FLASHING) return this.nack(f, 'BUSY')
        this.state = UPL_STATE.IDLE
        return this.ack(f)
    }
  }

  private startFlash(target: number): void {
    this.state = UPL_STATE.FLASHING
    const script = this.next
    this.next = {}
    const blocks = Math.ceil(this.len / BOOT.blockBytes)
    const steps = script.steps ?? flashSteps(blocks)
    const id = parseIdentity(this.img.subarray(0, this.len))
    const own = id.ok ? id.id.version : '0.0.0'
    steps.forEach((s, n) => {
      this.after((n + 1) * this.stepMs - this.stepMs, () => this.status(target, s, blocks))
    })
    this.after(steps.length * this.stepMs, () => {
      const result = UPL_RESULT[script.result ?? 'OK']
      this.lastTarget = target
      this.lastResult = result
      const reported =
        result === UPL_RESULT.OK || result === UPL_RESULT.VERSION_MISMATCH
          ? (script.reports ?? own)
          : '0.0.0'
      this.lastFw = ver(reported)
      this.state = UPL_STATE.STAGED // the image stays staged: the client may flash it again
      if (!this.clientHere()) return
      const p = new Uint8Array(CAL_PAYLOAD_LEN[UPL_TYPE.UPL_RESULT]!)
      p[RESULT.RESULT] = result
      p[RESULT.TARGET] = target
      p.set(this.lastFw, RESULT.MAJOR)
      p[RESULT.ATTEMPTS] = (steps[steps.length - 1]?.attempt ?? 0) + 1
      p[RESULT.SECONDS] = Math.round((steps.length * this.stepMs) / 1000)
      this.reply(UPL_TYPE.UPL_RESULT, 0, p)
    })
  }

  private status(target: number, s: FlashStep, blocks: number): void {
    if (!this.clientHere()) return
    const p = new Uint8Array(CAL_PAYLOAD_LEN[UPL_TYPE.UPL_STATUS]!)
    p[STATUS.PHASE] = UPL_PHASE[s.phase]
    p[STATUS.TARGET] = target
    p[STATUS.ATTEMPT] = s.attempt ?? 0
    put16(p, STATUS.BLOCK, s.block ?? 0)
    put16(p, STATUS.BLOCKS, blocks)
    this.reply(UPL_TYPE.UPL_STATUS, 0, p)
  }

  private clientHere(): boolean {
    return Date.now() - this.lastClientMs < FAKE_CLIENT_GONE_MS
  }

  private infoAck(): Uint8Array {
    const p = new Uint8Array(CAL_PAYLOAD_LEN[UPL_TYPE.UPL_INFO_ACK]!)
    p[INFO.PROTO] = UPL_PROTO.version
    p[INFO.MAX_IMAGE_KB] = UPL_PROTO.maxImageBytes / 1024
    put16(p, INFO.CHUNK, UPL_PROTO.chunkBytes)
    p[INFO.STATE] = this.state
    p[INFO.LAST_TARGET] = this.lastTarget
    p[INFO.LAST_RESULT] = this.lastResult
    p.set(this.lastFw, INFO.LAST_MAJOR)
    const b = this.bundle && parseIdentity(this.bundle)
    if (b?.ok) p.set(ver(b.id.version), INFO.BRIDGE_MAJOR)
    return p
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  private ack(f: Frame): void {
    this.reply(UPL_TYPE.ACK, f.seq, Uint8Array.of(f.type))
  }

  private nack(f: Frame, reason: CalNackName, detail = 0xff): void {
    this.reply(UPL_TYPE.NACK, f.seq, Uint8Array.of(f.type, CAL_NACK[reason], detail))
  }

  private reply(type: number, seq: number, payload: Uint8Array): void {
    this.send(buildFrame(type, seq, payload))
  }
}

const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const put16 = (b: Uint8Array, at: number, v: number) => {
  b[at] = v & 0xff
  b[at + 1] = (v >> 8) & 0xff
}
