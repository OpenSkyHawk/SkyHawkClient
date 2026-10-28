// Axis calibration (#46) over the SimGateway's serial port, as the app runs it (its own service
// since R2.2a): a CalLink per port, the read-on-open that drives the HID tab's badges, the
// cal* commands as discriminated CalResults, the restore cache, RAW batching, the last-confirmed
// snapshot and the export gate. It hosts the calibration workflow (R3.1): the cal* commands are
// the workflow's, RAW batches feed it, and it pushes `cal:workflow`.
//
// It rides on the Gateway connection (gateway LinkRider) for the port's moments, and is the link's
// calibration frame filter (CalFrameFilter): GatewayConnection runs it on every incoming chunk, and
// the codec's CalDemux inside CalLink takes the frames out.
import type {
  CachedAxis,
  CachedBoard,
  CalCache,
  CalCacheEntry,
  CalCommitAxis,
  CalHello,
  CalRawSample,
  CalResult,
  CalibrationState,
  CalSnapshot
} from '@shared/hid/calibration'
import type { Emit } from '@shared/app'
import type { DeviceState, FirmwareVersion } from '@shared/gateway'
import {
  diagLogRow,
  gatewayRecovery,
  type CalFrameFilter,
  type GatewayRecovery,
  type LinkRider,
  type LinkTimer
} from '../../gateway'
import { CalLink, CalNackError, CalTimeoutError, type Log } from './cal-link'
import { loadCalCache, saveCalCache, type CacheFileEvents, type CacheFileIO } from './cache-store'
import { boardFor, dropAxis, regressedAxes, storeAxes, storedAsWritten } from './cache-rules'
import { CAL_AXIS_NONE, nackName, type CalFrame } from './codec'
import { CalibrationWorkflowHost } from './workflow-host'

/** RAW batches (`cal:raw` before R3.1): the serial monitor's cadence, as before the split. */
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
  /** Where the cache file's problems are reported (the event log); none, for a quiet owner. */
  cacheEvents?: CacheFileEvents
  log: Log
  /**
   * Where the connect read's conclusion goes when the Gateway recovered itself this boot (#169):
   * NodeHub, which shows it with the Gateway's health. This service only reads DIAG on the wire;
   * the Gateway topic decides what it means (gateway-diag).
   */
  recovered?: (recovery: GatewayRecovery) => void
  /**
   * The release the Gateway's USB side reports in HELLO_ACK (#173), once per connect; undefined
   * when HELLO went unanswered. NodeHub shows it on the Firmware sheet.
   */
  usbFirmware?: (fw: FirmwareVersion | undefined) => void
  /**
   * The connect read is over (HELLO, DIAG and the calibration read, answered or not): the channel
   * is free for the uploader's own connect read (#187).
   */
  connectRead?: () => void
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
  /** The calibration dialog's workflow, over this service's own commands. */
  readonly workflow: CalibrationWorkflowHost
  private readonly workflowCbs = new Set<(state: CalibrationState) => void>()
  /** The uploader's unsolicited frames (#366), across port opens: each CalLink hands them here. */
  private readonly unsolicitedCbs = new Set<(f: CalFrame) => void>()

  constructor(
    private readonly emit: Emit,
    private readonly deps: HidCalibrationDeps
  ) {
    this.workflow = new CalibrationWorkflowHost(
      {
        calRead: () => this.calRead(),
        calSessionOpen: (axisIdx) => this.calSessionOpen(axisIdx),
        calStreamSelect: (axisIdx) => this.calStreamSelect(axisIdx),
        calCommit: (axis) => this.calCommit(axis),
        calReset: (idx) => this.calReset(idx),
        calSessionClose: () => this.calSessionClose(),
        calCacheRead: async () => this.calCacheRead(),
        calCacheStore: async (axes) => this.calCacheStore(axes),
        calCacheDrop: async (idx) => this.calCacheDrop(idx)
      },
      (state) => {
        this.emit('cal:workflow', state)
        for (const cb of this.workflowCbs) cb(state)
      }
    )
  }

  /** Each `cal:workflow` push, after it went out (HidService follows the device's presentMask). */
  onWorkflow(cb: (state: CalibrationState) => void): void {
    this.workflowCbs.add(cb)
  }

  /** The link's state changed (GatewayConnection's onStatus). */
  linkStatus(state: DeviceState): void {
    this.workflow.linkStatus(state)
  }

  // ── the link's moments (LinkRider) ─────────────────────────────────────────

  /** RAW batching, on the link's timer list. */
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
    this.cal.onUnsolicited((f) => {
      for (const cb of this.unsolicitedCbs) cb(f)
    })
  }

  // ── the Gateway's uploader's channel (#187) ────────────────────────────────

  /**
   * A request on this port's calibration channel, for the uploader (app/uploader-link): with no
   * port open it times out at once, as an unanswered request does.
   * @throws CalNackError, CalTimeoutError
   */
  exchange(type: number, payload?: Uint8Array, timeoutMs?: number): Promise<CalFrame> {
    if (!this.cal) return Promise.reject(new CalTimeoutError(type, 0))
    return this.cal.exchange(type, payload, timeoutMs)
  }

  /** The uploader's UPL_STATUS / UPL_RESULT, on whichever port is open; returns the unsubscribe. */
  onUnsolicited(cb: (f: CalFrame) => void): () => void {
    this.unsolicitedCbs.add(cb)
    return () => this.unsolicitedCbs.delete(cb)
  }

  /** A calibration session is open on the Gateway: it refuses an update meanwhile (#187). */
  get sessionOpen(): boolean {
    return !!this.cal?.inSession
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
    void this.readCalibrationState().finally(() => this.deps.connectRead?.())
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
      this.deps.usbFirmware?.(undefined)
      return
    }
    const { proto, blobVersion, fw } = hello.value
    this.deps.usbFirmware?.(fw)
    this.deps.log('cal.hello', {
      proto,
      blobVersion,
      fw: `${fw.major}.${fw.minor}.${fw.patch}`,
      serial: this.calSerialNumber ?? null
    })
    // Every connect reads the link-health record (#169), right after HELLO.
    await this.readGatewayDiag()
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

  /** Convert a CalLink rejection into the discriminated result the workflow can branch on. */
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
        const name = nackName(err.reason)
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

  /**
   * Read the Gateway's link health (#169): GET_DIAG, once per connect (after HELLO), never again
   * while the link stays up: any self-recovery drops the port, so the next connect's read finds
   * it. The whole record goes to the debug log (opt-in); only a recovery is handed on. A timeout
   * is older firmware ("not supported"), not a fault to retry.
   */
  private async readGatewayDiag(): Promise<void> {
    const r = await this.calRun((l) => l.getDiag())
    if (!r.ok && r.kind !== 'timeout') {
      this.deps.log('cal.diag', `read failed: ${r.message}`)
      return
    }
    if (!r.ok) {
      this.deps.log('cal.diag', { supported: false })
      return
    }
    this.deps.log('cal.diag', diagLogRow(r.value))
    const recovery = gatewayRecovery(r.value, Date.now(), this.calSerialNumber)
    if (recovery) this.deps.recovered?.(recovery)
  }

  /** Read stored calibration and report it to the workflow, so badges follow the device. */
  async calRead(): Promise<CalResult<CalSnapshot>> {
    const r = await this.calRun((l) => l.getCal())
    if (r.ok) {
      const snap: CalSnapshot = { ...r.value, serialNumber: this.calSerialNumber }
      this.lastCal = snap
      this.workflow.reported(snap)
      return { ok: true, value: snap }
    }
    return r
  }

  private loadCache(): CalCache {
    return loadCalCache(this.deps.cacheFile, this.deps.cacheEvents)
  }

  private saveCache(cache: CalCache): void {
    saveCalCache(cache, this.deps.cacheFile, this.deps.cacheEvents)
  }

  /**
   * What the cache holds for the attached board, and which of its axes the device has lost.
   *
   * Regression is computed here rather than in the renderer because the serial lives here — the
   * renderer never sees a board identity it could accidentally key on.
   */
  calCacheRead(): CalResult<{ board?: CachedBoard; regressed: number[] }> {
    const cache = this.loadCache()
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
    this.saveCache(storeAxes(this.loadCache(), serial, entries, new Date().toISOString()))
    return { ok: true, value: null }
  }

  /** Forget a deliberately deleted axis, or the whole board on the reset-all index. */
  calCacheDrop(idx: number): CalResult<null> {
    const serial = this.calSerialNumber
    if (!serial) return { ok: true, value: null }
    this.saveCache(dropAxis(this.loadCache(), serial, idx === CAL_AXIS_NONE ? undefined : idx))
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

  /** This computer has a saved copy of every one of `axes` for the attached Gateway (#173). */
  hasSavedCopy(axes: number[]): boolean {
    const board = boardFor(this.loadCache(), this.calSerialNumber)
    return !!board && axes.every((idx) => board.axes[idx])
  }

  /** The saved axes the Gateway now reports present but uncalibrated (regressedAxes, #173). */
  regressedNow(): number[] {
    return regressedAxes(this.loadCache(), this.lastCal)
  }

  /**
   * After a firmware update cleared the Gateway's calibration (#173): write this computer's copy
   * back for `axes`, with no dialog and no prompt. One session streaming nothing, one COMMIT per
   * axis, each read back and judged by the dialog's own rule (storedAsWritten). True when every
   * axis stored; false at the first that didn't, or with no copy for this board.
   */
  async restoreSaved(axes: number[]): Promise<boolean> {
    const board = boardFor(this.loadCache(), this.calSerialNumber)
    if (!board || !this.hasSavedCopy(axes)) return false
    const open = await this.calSessionOpen(CAL_AXIS_NONE)
    if (!open.ok) return false
    try {
      for (const idx of axes) {
        const a = board.axes[idx]!
        const commit = await this.calCommit({ idx, min: a.min, centre: a.centre, max: a.max })
        if (!commit.ok) return false
        const read = await this.calRead()
        if (!read.ok || !storedAsWritten(read.value.axes[idx], a)) return false
      }
      return true
    } finally {
      await this.calSessionClose()
    }
  }

  private flushCalRaw(): void {
    if (this.calRawBuf.length === 0) return
    this.workflow.ingest(this.calRawBuf.splice(0, this.calRawBuf.length))
  }
}
