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
// Values are unsigned 0–65535 on the wire and in device storage, matching the node, and stay
// that way throughout the client. The ±32767 seen on the HID tab comes from the HID report,
// where the firmware applied the offset; nothing here re-derives it.

import {
  CAL_ACK_FIELD,
  CAL_COMMIT_FIELD,
  CAL_DATA_FIELD,
  CAL_DATA_REC_FIELD,
  CAL_DIAG_BYTES,
  CAL_DIAG_FIELD,
  CAL_HELLO_ACK_FIELD,
  CAL_NACK_FIELD,
  CAL_NACK_REASONS,
  CAL_PAYLOAD_LEN,
  CAL_PROTO,
  CAL_RAW_FIELD,
  CAL_RESET_FIELD,
  CAL_SESSION_ACK_FIELD,
  CAL_SESSION_OPEN_FIELD,
  CAL_TYPES
} from '@shared/firmware'
import type { GatewayDiag } from '@shared/gateway'

/**
 * Constants from the generated firmware reference (shared/firmware, AxisCal.h), under the names
 * the codec and its callers use. Nothing here is restated: a firmware bump changes them at sync.
 */
export const CAL_PROTO_VERSION = CAL_PROTO.version

/** Frame lead-in, "\xAA S K C". */
export const CAL_MAGIC = Uint8Array.from(CAL_PROTO.magic)

/** magic 4 + type 1 + seq 1 + len 2 + crc 2. */
const CAL_ENVELOPE_BYTES = CAL_PROTO.envelopeBytes

/** HID report axis slots. Fixed by the descriptor, not by how many a cockpit populates. */
export const AXIS_CAL_SLOTS = CAL_PROTO.axisSlots

/** Axis sentinel: "all" for RESET, "none" for SESSION_OPEN / STREAM_SELECT. */
export const CAL_AXIS_NONE = CAL_PROTO.axisNone

/**
 * A generated code-keyed table, turned around: name -> wire code. Keyed by the table's generated
 * name union, so `CAL_TYPE.HELLO` type-checks and a misspelt name does not compile.
 */
function byName<N extends string>(
  table: Partial<Record<number, { name: N }>>
): Readonly<Record<N, number>> {
  return Object.fromEntries(
    Object.entries(table).map(([code, info]) => [info!.name, Number(code)])
  ) as Record<N, number>
}

/** Message types, by name (CAL_TYPES). High bit set = device -> client. */
export const CAL_TYPE = byName(CAL_TYPES)

/**
 * NACK reasons, by name (CAL_NACK_REASONS).
 *
 * Only five can ever reach a client. BAD_CRC, BAD_LENGTH and BAD_TYPE are all rejected at the
 * gateway's framing layer, where a failing candidate is not a frame at all — its bytes are
 * relayed onward rather than answered. **A protocol-version mismatch therefore surfaces as a
 * timeout on HELLO, never as a NACK**, so the no-answer path has to cover no-device,
 * wrong-firmware and newer-protocol alike.
 */
export const CAL_NACK = byName(CAL_NACK_REASONS)

/**
 * A NACK reason's name (X11): the synced firmware table's name for any reason it lists, the five
 * reachable ones and the three that never reach a client alike; anything else as `reason 0x…`.
 * The one name both CalLink's refusal message and a calibration failure's `reasonName` carry.
 */
export function nackName(reason: number): string {
  return CAL_NACK_REASONS[reason]?.name ?? `reason 0x${reason.toString(16)}`
}

/**
 * The one legal payload length per type (generated CAL_PAYLOAD_LEN).
 *
 * `LEN` is not merely bounded, it is fixed by `TYPE`, and it is checked **before the payload is
 * buffered**. `LEN` is read before the CRC can be verified, so on a false frame it is noise: a
 * stray magic in DCS-BIOS text can decode a length near 65535, and a receiver that waits for
 * that many bytes stalls its line assembly. There are no variable-length types — COMMIT carries
 * exactly one axis — so there is no exception to state or to get wrong.
 */
export { CAL_PAYLOAD_LEN }

/** Largest complete frame, and therefore the hard bound on CalDemux's carry. */
export const CAL_MAX_FRAME = CAL_PROTO.maxFrame

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
//
// **One convention, no conversion: unsigned 0-65535 everywhere.** RAW's `raw` and `cal`, the
// CAL_DATA endpoints, and what COMMIT stores are all in the node's ADC space, and stay that way
// through the client.
//
// The unsigned->signed offset exists once in the whole system, at SimGateway.cpp:216 inside
// HIDAxis::dispatch(), which subtracts 32768 on the way into the HID report. It is a fixed
// constant, never per-axis: all the per-axis variation lives in the stored `centre`, which is
// why an axis resting at raw 34728 still reads exactly 0 to DCS. Nothing is lost by leaving the
// offset unapplied here, and the signed view already exists on the HID tab, read straight from
// the report where the firmware put it.
//
// Converting only some values would be the worst of both: the offset applied twice, or not at
// all, still yields plausible in-range numbers and fails silently, and endpoints would be shown
// in units other than the ones being committed.

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
  // Nothing the device sends is larger. A client-only type can be (UPL_DATA, 260 bytes): holding
  // for one would let a stray magic in the DCS stream keep more than CAL_MAX_FRAME back.
  if (total > CAL_MAX_FRAME) return INVALID
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
//
// Payload offsets are the generated CAL_*_FIELD tables (AxisCal.h). Multi-byte fields are
// little-endian.

const u16 = (p: Uint8Array, off: number) => p[off]! | (p[off + 1]! << 8)

export interface HelloAck {
  /** Gate on this, not on `fw` — there has been no firmware release. */
  proto: number
  blobVersion: number
  axisSlots: number
  fw: { major: number; minor: number; patch: number }
}

export function decodeHelloAck(p: Uint8Array): HelloAck {
  const F = CAL_HELLO_ACK_FIELD
  return {
    proto: p[F.PROTO]!,
    blobVersion: p[F.BLOB_VERSION]!,
    axisSlots: p[F.AXIS_SLOTS]!,
    fw: { major: p[F.FW_MAJOR]!, minor: p[F.FW_MINOR]!, patch: p[F.FW_PATCH]! }
  }
}

interface CalAxis {
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
  const presentMask = p[CAL_DATA_FIELD.PRESENT_MASK]!
  const calibratedMask = p[CAL_DATA_FIELD.CALIBRATED_MASK]!
  const R = CAL_DATA_REC_FIELD
  const axes: CalAxis[] = []
  for (let i = 0; i < AXIS_CAL_SLOTS; i++) {
    const o = CAL_DATA_FIELD.RECORDS + i * CAL_PROTO.dataRecBytes
    axes.push({
      idx: i,
      controlId: u16(p, o + R.CONTROL_ID),
      min: u16(p, o + R.MIN),
      centre: u16(p, o + R.CENTRE),
      max: u16(p, o + R.MAX),
      deadzone: u16(p, o + R.DEADZONE),
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
  const F = CAL_SESSION_ACK_FIELD
  return {
    timeoutMs: u16(p, F.TIMEOUT_MS) | (u16(p, F.TIMEOUT_MS + 2) << 16), // u32 as two u16 halves
    axisIdx: p[F.AXIS_IDX]!
  }
}

/** The type being acknowledged. */
export function decodeAck(p: Uint8Array): { type: number } {
  return { type: p[CAL_ACK_FIELD.TYPE]! }
}

export interface Nack {
  type: number
  reason: number
  /** Axis index where one applies, else CAL_AXIS_NONE. */
  detail: number
}

export function decodeNack(p: Uint8Array): Nack {
  const F = CAL_NACK_FIELD
  return { type: p[F.TYPE]!, reason: p[F.REASON]!, detail: p[F.DETAIL]! }
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
  const F = CAL_RAW_FIELD
  return { idx: p[F.IDX]!, raw: u16(p, F.RAW), cal: u16(p, F.CAL) }
}

/** u32 little-endian, unsigned: `millis()` passes 2^31 after ~25 days up. */
const u32 = (p: Uint8Array, off: number) => u16(p, off) + u16(p, off + 2) * 0x10000

/**
 * DIAG (#169): the Gateway's link-health record. Reads the fields this client knows; bytes from
 * CAL_DIAG_FIELD.RESERVED on are sent as 0 and ignored, so a later firmware can fill them.
 * @throws on any length but CAL_DIAG_BYTES — the demux only hands over that one, so this is a
 *         programming error, never wire noise.
 */
export function decodeDiag(p: Uint8Array): GatewayDiag {
  if (p.length !== CAL_DIAG_BYTES) {
    throw new Error(`calibration: DIAG takes ${CAL_DIAG_BYTES} payload bytes, got ${p.length}`)
  }
  const F = CAL_DIAG_FIELD
  return {
    uptimeMs: u32(p, F.UPTIME_MS),
    firstUartErrMs: u32(p, F.FIRST_UART_ERR_MS),
    lastUartErrMs: u32(p, F.LAST_UART_ERR_MS),
    firstUsbLossMs: u32(p, F.FIRST_USB_LOSS_MS),
    lastUsbLossMs: u32(p, F.LAST_USB_LOSS_MS),
    uartOverrun: u16(p, F.UART_OVERRUN),
    uartFraming: u16(p, F.UART_FRAMING),
    uartBreak: u16(p, F.UART_BREAK),
    uartParity: u16(p, F.UART_PARITY),
    uartRxOverflow: u16(p, F.UART_RX_OVERFLOW),
    linesDropped: u16(p, F.LINES_DROPPED),
    linesCorrupt: u16(p, F.LINES_CORRUPT),
    linesOverlong: u16(p, F.LINES_OVERLONG),
    framesDropped: u16(p, F.FRAMES_DROPPED),
    uartRestarts: u16(p, F.UART_RESTARTS),
    usbReattaches: u16(p, F.USB_REATTACHES),
    cdcStalls: u16(p, F.CDC_STALLS),
    recoveryReboots: p[F.RECOVERY_REBOOTS]!,
    watchdogResets: p[F.WATCHDOG_RESETS]!,
    resetReason: p[F.RESET_REASON]!
  }
}

// ── encoders ─────────────────────────────────────────────────────────────────

/**
 * A one-field, one-byte payload: `byte` at offset `at`. Sized `at + 1`, so a firmware layout that
 * moved the field off byte 0 fails buildFrame's length check instead of sending a zero.
 */
const one = (type: number, seq: number, at: number, byte: number) => {
  const p = new Uint8Array(at + 1)
  p[at] = byte
  return buildFrame(type, seq, p)
}

export const encodeHello = (seq: number) => buildFrame(CAL_TYPE.HELLO, seq)

/** Opens a session and starts RAW for `axisIdx` (CAL_AXIS_NONE for none). */
export const encodeSessionOpen = (seq: number, axisIdx: number) =>
  one(CAL_TYPE.SESSION_OPEN, seq, CAL_SESSION_OPEN_FIELD.AXIS_IDX, axisIdx)

/** Deletes stored calibration for one axis, or all with CAL_AXIS_NONE. Persists immediately. */
export const encodeReset = (seq: number, idx: number) =>
  one(CAL_TYPE.RESET, seq, CAL_RESET_FIELD.IDX, idx)

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
  const F = CAL_COMMIT_FIELD
  const p = new Uint8Array(CAL_PAYLOAD_LEN[CAL_TYPE.COMMIT]!)
  p[F.IDX] = axis.idx
  const put = (off: number, v: number) => {
    p[off] = v & 0xff
    p[off + 1] = (v >> 8) & 0xff
  }
  put(F.MIN, axis.min)
  put(F.CENTRE, axis.centre)
  put(F.MAX, axis.max)
  put(F.DEADZONE, 0)
  return buildFrame(CAL_TYPE.COMMIT, seq, p)
}
