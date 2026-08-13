// SimGateway axis-calibration codec (pure, no Node/Electron deps, fully testable).
//
// Wire contract: FirmwarePlan/03-uart-usb-hid-protocol.md § Calibration Protocol (USB CDC).
// That page is authoritative; this file implements it and nothing more.
//
//   MAGIC 4 | TYPE 1 | SEQ 1 | LEN 2 (u16LE) | PAYLOAD LEN | CRC16 2 (u16LE)
//
// CRC covers TYPE‖SEQ‖LEN‖PAYLOAD — the magic is excluded, because checksumming constant
// bytes adds no detection power and doubles the chance of two implementations disagreeing.
//
// Values are unsigned 0–65535 on the wire and in device storage, matching the node. The
// ±32767 the HID report and DCS show is a display convention; see toSigned().

/**
 * Constants restated from src/main/reference/axis-cal.generated.ts.
 *
 * They are duplicated rather than imported because `src/shared` is aliased everywhere while
 * `src/main/reference` is not, so importing across that boundary inverts the layering — the
 * same reason nodes.ts restates SUPPORTED_NODE_PROTO and HFLAG_*. reference.test.ts asserts
 * the two agree on every entry, so a firmware bump fails loudly rather than drifting.
 */
export const CAL_PROTO_VERSION = 1

/** Frame lead-in, "\xAA S K C". */
export const CAL_MAGIC = Uint8Array.from([0xaa, 0x53, 0x4b, 0x43])

/** magic 4 + type 1 + seq 1 + len 2 + crc 2. */
export const CAL_ENVELOPE_BYTES = 10

/** CAL_DATA, the largest legal payload — and the bound on how much a receiver may buffer. */
export const CAL_MAX_PAYLOAD = 82

/** HID report axis slots. Fixed by the descriptor, not by how many a cockpit populates. */
export const AXIS_CAL_SLOTS = 8

/** Axis sentinel: "all" for RESET, "none" for SESSION_OPEN / STREAM_SELECT. */
export const CAL_AXIS_NONE = 0xff

/** Message types. High bit set = device -> client. */
export const CAL_TYPE = {
  HELLO: 0x01,
  GET_CAL: 0x02,
  SESSION_OPEN: 0x03,
  SESSION_CLOSE: 0x04,
  COMMIT: 0x05,
  RESET: 0x06,
  KEEPALIVE: 0x07,
  STREAM_SELECT: 0x08,
  HELLO_ACK: 0x81,
  CAL_DATA: 0x82,
  SESSION_ACK: 0x83,
  ACK: 0x84,
  NACK: 0x85,
  RAW: 0x86
} as const

/**
 * NACK reasons.
 *
 * Only five can ever reach a client. BAD_CRC, BAD_LENGTH and BAD_TYPE are all rejected at the
 * gateway's framing layer, where a failing candidate is not a frame at all — its bytes are
 * relayed onward rather than answered. **A protocol-version mismatch therefore surfaces as a
 * timeout on HELLO, never as a NACK**, so the no-answer path has to cover no-device,
 * wrong-firmware and newer-protocol alike.
 */
export const CAL_NACK = {
  BAD_CRC: 0x01,
  BAD_LENGTH: 0x02,
  BAD_TYPE: 0x03,
  BAD_INDEX: 0x04,
  BAD_ORDER: 0x05,
  NO_SESSION: 0x06,
  NO_STORAGE: 0x07,
  BAD_DEADZONE: 0x08
} as const

/**
 * The one legal payload length per type.
 *
 * `LEN` is not merely bounded, it is fixed by `TYPE`, and it is checked **before the payload is
 * buffered**. `LEN` is read before the CRC can be verified, so on a false frame it is noise: a
 * stray magic in DCS-BIOS text can decode a length near 65535, and a receiver that waits for
 * that many bytes stalls its line assembly. There are no variable-length types — COMMIT carries
 * exactly one axis — so there is no exception to state or to get wrong.
 */
export const CAL_PAYLOAD_LEN: Readonly<Record<number, number>> = {
  [CAL_TYPE.HELLO]: 0,
  [CAL_TYPE.GET_CAL]: 0,
  [CAL_TYPE.SESSION_OPEN]: 1,
  [CAL_TYPE.SESSION_CLOSE]: 0,
  [CAL_TYPE.COMMIT]: 9,
  [CAL_TYPE.RESET]: 1,
  [CAL_TYPE.KEEPALIVE]: 0,
  [CAL_TYPE.STREAM_SELECT]: 1,
  [CAL_TYPE.HELLO_ACK]: 6,
  [CAL_TYPE.CAL_DATA]: 82,
  [CAL_TYPE.SESSION_ACK]: 5,
  [CAL_TYPE.ACK]: 1,
  [CAL_TYPE.NACK]: 3,
  [CAL_TYPE.RAW]: 5
}

/** Largest complete frame, and therefore the hard bound on CalDemux's carry. */
export const CAL_MAX_FRAME = CAL_ENVELOPE_BYTES + CAL_MAX_PAYLOAD

// ── CRC ──────────────────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no input or output reflection, no final XOR.
 * Canonical check: "123456789" -> 0x29B1.
 *
 * Init is 0xFFFF rather than 0x0000 so leading zero bytes change the result — an all-zero
 * buffer is a realistic corruption mode and a 0x0000 init could not distinguish it from a
 * shorter all-zero one.
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

// ── units ────────────────────────────────────────────────────────────────────

/**
 * Unsigned wire value -> the signed ±32767 the HID report and DCS display.
 *
 * **This is the only unsigned->signed conversion in the client, and it must stay that way.**
 * Applying the offset twice, or zero times, still yields plausible in-range values, so getting
 * it wrong is silent rather than loud. Capture and COMMIT work in unsigned throughout; convert
 * once, at the display edge.
 */
export function toSigned(unsigned: number): number {
  return unsigned - 32768
}

// ── framing ──────────────────────────────────────────────────────────────────

export interface CalFrame {
  type: number
  /** Echoed from the request; on unsolicited RAW, a free-running per-session counter. */
  seq: number
  payload: Uint8Array
}

/**
 * Build a complete frame.
 * @throws if `payload` is not the one legal length for `type` — a client-side programming
 *         error, and silently emitting an unparseable frame would be worse.
 */
export function buildFrame(type: number, seq: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0)
  const want = CAL_PAYLOAD_LEN[type]
  if (want === undefined) throw new Error(`calibration: unknown frame type 0x${type.toString(16)}`)
  if (body.length !== want) {
    throw new Error(
      `calibration: type 0x${type.toString(16)} takes exactly ${want} payload bytes, got ${body.length}`
    )
  }

  const frame = new Uint8Array(CAL_ENVELOPE_BYTES + body.length)
  frame.set(CAL_MAGIC, 0)
  frame[4] = type
  frame[5] = seq & 0xff
  frame[6] = body.length & 0xff
  frame[7] = (body.length >> 8) & 0xff
  frame.set(body, 8)

  // Coverage starts at TYPE and ends at the last payload byte — magic excluded.
  const crc = crc16(frame.subarray(4, 8 + body.length))
  frame[8 + body.length] = crc & 0xff
  frame[9 + body.length] = (crc >> 8) & 0xff
  return frame
}

type Verdict =
  | { kind: 'frame'; frame: CalFrame; total: number }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }

const INCOMPLETE: Verdict = { kind: 'incomplete' }
const INVALID: Verdict = { kind: 'invalid' }

/** Classify the candidate starting at `at`. Never reads past the end of `buf`. */
function classify(buf: Uint8Array, at: number): Verdict {
  const avail = buf.length - at

  for (let k = 0; k < Math.min(CAL_MAGIC.length, avail); k++) {
    if (buf[at + k] !== CAL_MAGIC[k]) return INVALID
  }
  // Magic matches as far as we can see, but we cannot see all of it yet.
  if (avail < CAL_ENVELOPE_BYTES - 2) return INCOMPLETE

  const type = buf[at + 4]!
  const len = buf[at + 6]! | (buf[at + 7]! << 8)
  if (CAL_PAYLOAD_LEN[type] !== len) return INVALID // unknown type lands here too

  const total = CAL_ENVELOPE_BYTES + len
  if (avail < total) return INCOMPLETE

  const want = buf[at + 8 + len]! | (buf[at + 9 + len]! << 8)
  if (crc16(buf.subarray(at + 4, at + 8 + len)) !== want) return INVALID

  return {
    kind: 'frame',
    frame: { type, seq: buf[at + 5]!, payload: buf.slice(at + 8, at + 8 + len) },
    total
  }
}

/**
 * Streaming de-multiplexer: pulls calibration frames out of the inbound serial stream and hands
 * everything else back untouched.
 *
 * Run it **always, while the port is open** — not only during a session, and not only while an
 * exchange is in flight. HELLO and GET_CAL are answered outside a session and their responses
 * are binary frames that must be removed before the DCS relay and before line assembly. The
 * gateway made the same call for the same reason: one parser, always on.
 *
 * `push` returns both the frames and the bytes to pass onward, so "re-emit rejected bytes" is
 * structural rather than a rule the caller has to remember. Dropping them would silently
 * swallow a DCS-BIOS line, because the magic is *not* collision-proof outbound — the gateway's
 * own parser resync emits a bare 0xAA whenever a UART 0xAA is not followed by 0x55.
 */
export class CalDemux {
  private carry = new Uint8Array(0)

  push(chunk: Uint8Array): { frames: CalFrame[]; passthrough: Uint8Array } {
    let buf: Uint8Array
    if (this.carry.length === 0) {
      buf = chunk
    } else {
      buf = new Uint8Array(this.carry.length + chunk.length)
      buf.set(this.carry, 0)
      buf.set(chunk, this.carry.length)
    }
    this.carry = new Uint8Array(0)

    const frames: CalFrame[] = []
    const out: number[] = []
    const emit = (from: number, to: number) => {
      for (let k = from; k < to; k++) out.push(buf[k]!)
    }

    let i = 0
    while (i < buf.length) {
      const j = buf.indexOf(CAL_MAGIC[0]!, i)
      if (j < 0) {
        emit(i, buf.length)
        break
      }
      emit(i, j)

      const v = classify(buf, j)
      if (v.kind === 'incomplete') {
        // Consistent with a valid prefix, just not enough bytes yet. Hold it — re-emitting
        // here would destroy any frame whose header straddles a chunk boundary.
        this.carry = buf.slice(j)
        break
      }
      if (v.kind === 'invalid') {
        // Proven not a frame. Give back its first byte and rescan from the next one; every
        // following byte is picked up by the pre-candidate emit above, so nothing is lost.
        // +1 is lossless because 0xAA appears nowhere else in the magic.
        out.push(buf[j]!)
        i = j + 1
        continue
      }
      frames.push(v.frame)
      i = j + v.total
    }

    return { frames, passthrough: Uint8Array.from(out) }
  }

  /** Release any held bytes — on port close, or the next reconnect starts mid-candidate. */
  flush(): Uint8Array {
    const held = this.carry
    this.carry = new Uint8Array(0)
    return held
  }

  /** Bytes currently held. Bounded by CAL_MAX_FRAME; exposed so a test can assert that. */
  get pending(): number {
    return this.carry.length
  }
}

// ── decoders ─────────────────────────────────────────────────────────────────

const u16 = (p: Uint8Array, off: number) => p[off]! | (p[off + 1]! << 8)

export interface HelloAck {
  /** Gate on this, not on `fw` — there has been no firmware release. */
  proto: number
  blobVersion: number
  axisSlots: number
  fw: { major: number; minor: number; patch: number }
}

export function decodeHelloAck(p: Uint8Array): HelloAck {
  return {
    proto: p[0]!,
    blobVersion: p[1]!,
    axisSlots: p[2]!,
    fw: { major: p[3]!, minor: p[4]!, patch: p[5]! }
  }
}

export interface CalAxis {
  idx: number
  /** CAN controlId, 0x0000 for an absent slot. The client infers self-centring from this. */
  controlId: number
  /** Unsigned 0–65535, as stored on the device. */
  min: number
  centre: number
  max: number
  /** Reserved, always 0 in this protocol version. */
  deadzone: number
  /** presentMask bit — a HIDAxis with this index is declared in the gateway sketch. */
  present: boolean
  /** calibratedMask bit — stored endpoints are ordered. */
  calibrated: boolean
}

export interface CalData {
  presentMask: number
  calibratedMask: number
  /** All 8 slots, always. Display only those with `present`. */
  axes: CalAxis[]
}

export function decodeCalData(p: Uint8Array): CalData {
  const presentMask = p[0]!
  const calibratedMask = p[1]!
  const axes: CalAxis[] = []
  for (let i = 0; i < AXIS_CAL_SLOTS; i++) {
    const o = 2 + i * 10
    axes.push({
      idx: i,
      controlId: u16(p, o),
      min: u16(p, o + 2),
      centre: u16(p, o + 4),
      max: u16(p, o + 6),
      deadzone: u16(p, o + 8),
      present: (presentMask & (1 << i)) !== 0,
      calibrated: (calibratedMask & (1 << i)) !== 0
    })
  }
  return { presentMask, calibratedMask, axes }
}

export interface SessionAck {
  timeoutMs: number
  /** Echoed selection; CAL_AXIS_NONE when nothing streams. */
  axisIdx: number
}

export function decodeSessionAck(p: Uint8Array): SessionAck {
  return { timeoutMs: u16(p, 0) | (u16(p, 2) << 16), axisIdx: p[4]! }
}

/** The type being acknowledged. */
export function decodeAck(p: Uint8Array): { type: number } {
  return { type: p[0]! }
}

export interface Nack {
  type: number
  reason: number
  /** Axis index where one applies, else CAL_AXIS_NONE. */
  detail: number
}

export function decodeNack(p: Uint8Array): Nack {
  return { type: p[0]!, reason: p[1]!, detail: p[2]! }
}

export interface RawSample {
  idx: number
  /** Pre-transform sensor reading. */
  raw: number
  /**
   * The same sample through the calibration the device **currently holds** — the old one, or
   * none. It does not preview endpoints being captured; their effect appears only after COMMIT
   * and the read-back that follows.
   */
  cal: number
}

export function decodeRaw(p: Uint8Array): RawSample {
  return { idx: p[0]!, raw: u16(p, 1), cal: u16(p, 3) }
}

// ── encoders ─────────────────────────────────────────────────────────────────

const one = (type: number, seq: number, byte: number) =>
  buildFrame(type, seq, Uint8Array.from([byte]))

export const encodeHello = (seq: number) => buildFrame(CAL_TYPE.HELLO, seq)
export const encodeGetCal = (seq: number) => buildFrame(CAL_TYPE.GET_CAL, seq)
export const encodeSessionClose = (seq: number) => buildFrame(CAL_TYPE.SESSION_CLOSE, seq)
export const encodeKeepalive = (seq: number) => buildFrame(CAL_TYPE.KEEPALIVE, seq)

/** Opens a session and starts RAW for `axisIdx` (CAL_AXIS_NONE for none). */
export const encodeSessionOpen = (seq: number, axisIdx: number) =>
  one(CAL_TYPE.SESSION_OPEN, seq, axisIdx)

/** Changes which axis streams mid-session. Requires an open session. */
export const encodeStreamSelect = (seq: number, axisIdx: number) =>
  one(CAL_TYPE.STREAM_SELECT, seq, axisIdx)

/** Deletes stored calibration for one axis, or all with CAL_AXIS_NONE. Persists immediately. */
export const encodeReset = (seq: number, idx: number) => one(CAL_TYPE.RESET, seq, idx)

/**
 * Writes one axis and persists it. Exactly one axis per COMMIT, never a batch — a batch could
 * name the same axis twice with different values and silently apply the last.
 *
 * `deadzone` is forced to 0: the field is reserved in this protocol version and a non-zero
 * value is refused with NACK BAD_DEADZONE.
 */
export function encodeCommit(
  seq: number,
  axis: { idx: number; min: number; centre: number; max: number }
): Uint8Array {
  const p = new Uint8Array(9)
  p[0] = axis.idx
  const put = (off: number, v: number) => {
    p[off] = v & 0xff
    p[off + 1] = (v >> 8) & 0xff
  }
  put(1, axis.min)
  put(3, axis.centre)
  put(5, axis.max)
  put(7, 0)
  return buildFrame(CAL_TYPE.COMMIT, seq, p)
}
