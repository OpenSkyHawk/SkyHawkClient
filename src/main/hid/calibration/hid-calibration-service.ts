// Axis calibration (#46) over the SimGateway's serial port, as the app runs it (moved out of
// DeviceLink, R2.2a): a CalLink per port, the read-on-open that drives the HID tab's badges, the
// cal* commands as discriminated CalResults, the restore cache, `cal:raw` batching, the
// last-confirmed snapshot and the export gate.
//
// It rides on the Gateway connection (gateway LinkRider) for the port's moments, and is the link's
// calibration frame filter (CalFrameFilter): GatewayConnection runs it on every incoming chunk, and
// the codec's CalDemux inside CalLink takes the frames out.
import type {
  CachedAxis,
  CachedBoard,
  CalCacheEntry,
  CalCommitAxis,
  CalHello,
  CalRawSample,
  CalResult,
  CalSnapshot
} from '@shared/hid/calibration'
import type { Emit } from '@shared/app'
import type { CalFrameFilter, LinkRider, LinkTimer } from '../../gateway'
import { CalLink, CalNackError, CalTimeoutError, type Log } from './cal-link'
import { loadCalCache, saveCalCache, type CacheFileIO } from './cache-store'
import { boardFor, dropAxis, regressedAxes, storeAxes } from './cache-rules'
import { CAL_AXIS_NONE, nackReasonName } from './codec'

/** `cal:raw` batches: the serial monitor's cadence, as before the split. */
const CAL_RAW_FLUSH_MS = 50

/**
 * What the service needs from app: the write to the device and the board's USB serial
 * (GatewayConnection.write / usbSerialNumber), the calibration-cache.json port, and the debug log.
 */
export interface HidCalibrationDeps {
  write: (data: Buffer) => void
  /** USB serial of the attached gateway, the key of the restore cache (#46). */
  serialNumber: () => Promise<string | undefined>
  cacheFile: CacheFileIO
  log: Log
}

export class HidCalibrationService implements LinkRider, CalFrameFilter {
  private cal?: CalLink
  private calRawBuf: CalRawSample[] = []
  private calSerialNumber?: string
  /**
   * Last snapshot the device confirmed, held so a renderer reload can rehydrate.
   *
   * Cleared whenever the link goes down, which is what stops it describing a board that is no
   * longer attached — or, worse, a different one after a reconnect.
   */
  private lastCal?: CalSnapshot

  constructor(
    private readonly emit: Emit,
    private readonly deps: HidCalibrationDeps
  ) {}

  // ── the link's moments (LinkRider) ─────────────────────────────────────────

  /** `cal:raw` batching, on the link's timer list. */
  timers(every: LinkTimer): void {
    every(CAL_RAW_FLUSH_MS, () => this.flushCalRaw())
  }

  /**
   * The calibration channel shares this port. It runs whenever the port is open, not only
   * during a session: HELLO and GET_CAL are answered outside one, so there is no point at
   * which it is safe to stop watching for frames.
   */
  attach(): void {
    this.cal = new CalLink(
      (data) => this.deps.write(data),
      (sample) => this.calRawBuf.push({ t: Date.now(), ...sample }),
      this.deps.log
    )
  }

  /** The port is released. */
  release(): void {
    // Bytes the de-mux was holding are DCS traffic, but with the link going away deliberately
    // there is no stream left for them to belong to.
    this.cal?.close()
    this.cal = undefined
    this.calRawBuf = []
    this.lastCal = undefined
    this.calSerialNumber = undefined
  }

  /** Badges, with no dialog open. */
  opened(): void {
    void this.readCalibrationState()
  }

  /** The port closed under the link. */
  closed(pass: (held: Buffer) => void): void {
    // Fail anything in flight and release held bytes: a reconnect must not resume
    // mid-candidate, and an awaiting caller would otherwise hang on a reply that cannot come.
    // The released bytes are a candidate that never completed — not a frame, therefore DCS
    // traffic — so they go on down the relay rather than being dropped here.
    const held = this.cal?.close()
    if (held?.length) pass(held)
    this.lastCal = undefined // the board it described may not be the one that comes back
  }

  // ── the frame filter (CalFrameFilter) ──────────────────────────────────────

  ingest(chunk: Buffer): Buffer {
    return this.cal ? this.cal.ingest(chunk) : chunk
  }

  /**
   * A calibration exchange is in flight, and the export stream must not be forwarded.
   *
   * The protocol's one rule is that the client stops relaying the export stream before ANY
   * exchange, a 10 ms HELLO as much as a whole session: it frees the link and removes any chance
   * of the gateway reading export binary as a calibration frame.
   */
  get exportGated(): boolean {
    return !!this.cal?.exportGated
  }

  calSnapshot(): CalSnapshot | undefined {
    return this.lastCal
  }

  // ── axis calibration (#46) ─────────────────────────────────────────────────

  /**
   * Read-only: ask the gateway what it is and what calibration it holds, once per port open.
   *
   * Writes nothing. It exists so the HID tab can show per-axis calibrated/uncalibrated badges
   * and an uncalibrated count **without anyone opening the dialog** — which is precisely why
   * the firmware answers HELLO and GET_CAL outside a session. Everything that changes stored
   * calibration is scoped to an open dialog.
   *
   * Also captures the board's USB serial, the key part of the restore cache in #46.
   *
   * Failure is not an error state: a gateway on older firmware simply never answers, and the
   * relay is unaffected either way.
   */
  private async readCalibrationState(): Promise<void> {
    this.calSerialNumber = await this.deps.serialNumber()
    const hello = await this.calHello()
    if (!hello.ok) {
      this.deps.log('cal.absent', `no calibration channel: ${hello.message}`)
      return
    }
    const { proto, blobVersion, fw } = hello.value
    this.deps.log('cal.hello', {
      proto,
      blobVersion,
      fw: `${fw.major}.${fw.minor}.${fw.patch}`,
      serial: this.calSerialNumber ?? null
    })
    const read = await this.calRead()
    if (!read.ok) {
      this.deps.log('cal.absent', `read failed: ${read.message}`)
      return
    }
    // Masks, not endpoints: this is the line a bug report needs — which axes the sketch
    // declares, and which of them the device considers calibrated.
    this.deps.log('cal.data', {
      present: read.value.presentMask.toString(2).padStart(8, '0'),
      calibrated: read.value.calibratedMask.toString(2).padStart(8, '0')
    })
  }

  /** Convert a CalLink rejection into the discriminated result the renderer can branch on. */
  private async calRun<T>(fn: (link: CalLink) => Promise<T>): Promise<CalResult<T>> {
    if (!this.cal) {
      return { ok: false, kind: 'offline', message: 'Gateway is not connected' }
    }
    try {
      return { ok: true, value: await fn(this.cal) }
    } catch (err) {
      if (err instanceof CalTimeoutError) {
        return { ok: false, kind: 'timeout', message: err.message }
      }
      if (err instanceof CalNackError) {
        const name = nackReasonName(err.reason)
        return {
          ok: false,
          kind: 'nack',
          reason: err.reason,
          reasonName: name,
          detail: err.detail,
          message: err.message
        }
      }
      return { ok: false, kind: 'error', message: (err as Error).message }
    }
  }

  calHello(): Promise<CalResult<CalHello>> {
    return this.calRun((l) => l.hello())
  }

  /** Read stored calibration and push it to the renderer, so badges follow the device. */
  async calRead(): Promise<CalResult<CalSnapshot>> {
    const r = await this.calRun((l) => l.getCal())
    if (r.ok) {
      const snap: CalSnapshot = { ...r.value, serialNumber: this.calSerialNumber }
      this.lastCal = snap
      this.emit('cal:data', snap)
      return { ok: true, value: snap }
    }
    return r
  }

  /**
   * What the cache holds for the attached board, and which of its axes the device has lost.
   *
   * Regression is computed here rather than in the renderer because the serial lives here — the
   * renderer never sees a board identity it could accidentally key on.
   */
  calCacheRead(): CalResult<{ board?: CachedBoard; regressed: number[] }> {
    const cache = loadCalCache(this.deps.cacheFile)
    return {
      ok: true,
      value: {
        board: boardFor(cache, this.calSerialNumber),
        regressed: regressedAxes(cache, this.lastCal)
      }
    }
  }

  /** Record axes the device confirmed storing. A board with no serial is not cached at all. */
  calCacheStore(axes: CalCacheEntry[]): CalResult<null> {
    const serial = this.calSerialNumber
    if (!serial || axes.length === 0) return { ok: true, value: null }
    const entries: Record<number, CachedAxis> = {}
    for (const a of axes) {
      entries[a.idx] = { min: a.min, centre: a.centre, max: a.max, selfCentring: a.selfCentring }
    }
    saveCalCache(
      storeAxes(loadCalCache(this.deps.cacheFile), serial, entries, new Date().toISOString()),
      this.deps.cacheFile
    )
    return { ok: true, value: null }
  }

  /** Forget a deliberately deleted axis, or the whole board on the reset-all index. */
  calCacheDrop(idx: number): CalResult<null> {
    const serial = this.calSerialNumber
    if (!serial) return { ok: true, value: null }
    saveCalCache(
      dropAxis(loadCalCache(this.deps.cacheFile), serial, idx === CAL_AXIS_NONE ? undefined : idx),
      this.deps.cacheFile
    )
    return { ok: true, value: null }
  }

  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>> {
    return this.calRun((l) => l.openSession(axisIdx))
  }

  calStreamSelect(axisIdx: number): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.streamSelect(axisIdx)
      return null
    })
  }

  /**
   * Write one axis. Resolving means the device acknowledged receipt, not that it stored the
   * values — the caller re-reads with calRead() to learn what is actually on the device.
   */
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.commit(axis)
      return null
    })
  }

  calReset(idx: number): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.reset(idx)
      return null
    })
  }

  calSessionClose(): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.closeSession()
      return null
    })
  }

  private flushCalRaw(): void {
    if (this.calRawBuf.length === 0) return
    this.emit('cal:raw', this.calRawBuf.splice(0, this.calRawBuf.length))
  }
}
