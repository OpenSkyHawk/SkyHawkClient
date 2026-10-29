// The client side of the Gateway's firmware uploader (#366), with the board to flash as a
// parameter: the Gateway's own cockpit side (UPL_TARGET.bridge, #187), a board on the bus (1-63,
// #175) or the one unconfigured bootloader (UPL_TARGET.unconfigured, #177). Bench reference:
// OpenSkyhawk Firmware/Bootloader/tools/upload_gateway.py. Behaviour: FirmwarePlan/07 § Uploader.
//
// It drives the messages and nothing else. Which image, which target, what a result means for the
// board and what the dialog shows are the update flows' (main/update). The channel is a port app
// hands in over the calibration link, so this imports no other topic.
//
// - One session at a time: the Gateway refuses UPL_BEGIN / UPL_FLASH with BUSY while a calibration
//   session is open, and a calibration session while anything is staged. A flow sends UPL_ABORT
//   when its dialog closes.
// - While flashing, a frame from the client at least every few seconds keeps UPL_STATUS and
//   UPL_RESULT coming (the Gateway's CLIENT_GONE_MS, 5 s). Without them the Gateway still
//   finishes and keeps the result for UPL_INFO_ACK.
// - UPL_RESULT is sent once, and can be lost (a full USB buffer drops a whole frame, or the PC
//   naps). So the client's frame is UPL_INFO every second, not a bare KEEPALIVE: its answer is the
//   liveness check, and once it no longer reads FLASHING the flash has ended and its result is in
//   it. The Gateway sends UPL_RESULT before it answers any later UPL_INFO, so a result that did
//   arrive is always seen first.
// - UPL_STATUS comes on each phase and every 250 ms while writing, but entering the bootloader and
//   confirming can each run 10 s with none: liveness is never read from the status spacing.
// - Staged images are dropped after 30 s with no client frame (SESSION_IDLE_MS), so a later Retry
//   reads UPL_INFO first.
import { UPL_PROTO } from '@shared/firmware'
import {
  UPL_TYPE,
  decodeInfoAck,
  decodeResult,
  decodeStatus,
  encodeBegin,
  encodeData,
  encodeFlash,
  nackReasonName,
  type UplInfo,
  type UplOutcome,
  type UplStatus
} from './upl-codec'

/** One frame on the calibration channel, past its envelope. */
export interface UplFrame {
  type: number
  payload: Uint8Array
}

/** A request's answer: the reply frame, the Gateway's refusal (its NACK reason), or no answer. */
export type UplReply =
  | { ok: true; frame: UplFrame }
  | { ok: false; nack: number }
  | { ok: false; timeout: true }

/** The calibration channel, as app hands it in (app/uploader-link over hid's CalLink). */
export interface UploaderLink {
  /** Send a request and await its reply; `timeoutMs` overrides the channel's default. */
  exchange(type: number, payload?: Uint8Array, timeoutMs?: number): Promise<UplReply>
  /** UPL_STATUS / UPL_RESULT as they arrive; returns the unsubscribe. */
  onUnsolicited(cb: (f: UplFrame) => void): () => void
}

/** The client's own pacing. Not firmware values: the Gateway's limits are in the comments. */
export interface UploaderTiming {
  /** UPL_INFO while flashing: well inside the Gateway's 5 s CLIENT_GONE_MS. */
  probeMs: number
  /** UPL_INFOs in a row with no answer before contact is lost. */
  lostAfter: number
  /** Sends of one UPL_DATA chunk before staging gives up (the bench client's figure). */
  chunkTries: number
}

const TIMING: UploaderTiming = { probeMs: 1000, lostAfter: 3, chunkTries: 3 }

/** The uploader's requests, by name: what a refusal or a silence was an answer to. */
export type UplRequest =
  | 'UPL_INFO'
  | 'UPL_BEGIN'
  | 'UPL_DATA'
  | 'UPL_END'
  | 'UPL_FLASH'
  | 'UPL_ABORT'

/**
 * The Gateway refused a request (NACK). `reason` is the synced name, or the raw code for one this
 * client doesn't list: BUSY, TOO_LARGE, BAD_OFFSET, IMAGE_CRC, BAD_IMAGE, NOT_STAGED, NO_SESSION,
 * BAD_INDEX.
 */
export class UplRefused extends Error {
  constructor(
    readonly request: UplRequest,
    readonly reason: string
  ) {
    super(`uploader: ${request} refused (${reason})`)
    this.name = 'UplRefused'
  }
}

/** A request got no answer: no Gateway, a Gateway without the uploader, or the link went. */
export class UplNoAnswer extends Error {
  constructor(readonly request: UplRequest) {
    super(`uploader: no answer to ${request}`)
    this.name = 'UplNoAnswer'
  }
}

/**
 * A flash's result as UPL_INFO_ACK keeps it, for when UPL_RESULT never arrived. `NONE` there means
 * the Gateway's USB side restarted during the flash and lost it (it is kept in RAM only).
 */
const outcomeOf = (info: UplInfo): UplOutcome => ({
  via: 'info',
  result: info.lastResult,
  target: info.lastTarget,
  ...(info.lastFw && { fw: info.lastFw })
})

/** How a flash ended for the client: the Gateway's result, or contact lost before it came. */
export type FlashEnd = { lost: false; outcome: UplOutcome } | { lost: true }

/** Port: the debug log, handed in by app (debug.log lives in app). */
export type UplLog = (tag: string, data?: unknown) => void

export class UploaderClient {
  private readonly timing: UploaderTiming

  constructor(
    private readonly link: UploaderLink,
    timing?: Partial<UploaderTiming>,
    /** Every request's answer but the chunks', each status and the result (`upl`, `upl.*`). */
    private readonly log: UplLog = () => {}
  ) {
    this.timing = { ...TIMING, ...timing }
  }

  /** Send `request`; its reply frame, or a typed refusal / silence. */
  private async ask(request: UplRequest, payload?: Uint8Array): Promise<UplFrame> {
    const r = await this.link.exchange(UPL_TYPE[request], payload)
    // A chunk's ACK is one of hundreds: only a chunk that went wrong is logged.
    if (request !== 'UPL_DATA' || !r.ok) {
      this.log('upl', {
        request,
        answer: r.ok ? 'ok' : 'nack' in r ? (nackReasonName(r.nack) ?? r.nack) : 'no answer'
      })
    }
    if (r.ok) return r.frame
    if ('nack' in r) throw new UplRefused(request, nackReasonName(r.nack) ?? String(r.nack))
    throw new UplNoAnswer(request)
  }

  /**
   * The uploader's state, its last result and the bundled cockpit-side version. undefined when
   * nothing answers: no Gateway, or one older than the uploader (it relays the unknown type).
   */
  async info(): Promise<UplInfo | undefined> {
    try {
      const info = decodeInfoAck((await this.ask('UPL_INFO')).payload)
      this.log('upl.info', info)
      return info
    } catch (e) {
      if (e instanceof UplNoAnswer) return undefined
      throw e
    }
  }

  /**
   * Stage an image: UPL_BEGIN with its identity block's length and CRC, every chunk in order (one
   * outstanding; a chunk with no answer is sent again, by its offset), then UPL_END, where the
   * Gateway checks the CRC and the identity block. `progress` gets 0-100 as chunks are taken.
   * @throws UplRefused (BUSY during calibration, TOO_LARGE, IMAGE_CRC, BAD_IMAGE…) or UplNoAnswer.
   */
  async stage(
    image: Uint8Array,
    id: { imageLength: number; imageCrc: number },
    progress?: (pct: number) => void
  ): Promise<void> {
    this.log('upl.stage', { imageLength: id.imageLength, imageCrc: id.imageCrc })
    await this.ask('UPL_BEGIN', encodeBegin(id.imageLength, id.imageCrc))
    const chunk = UPL_PROTO.chunkBytes
    for (let off = 0; off < id.imageLength; off += chunk) {
      const data = encodeData(image, id.imageLength, off)
      for (let tryNo = 1; ; tryNo++) {
        try {
          await this.ask('UPL_DATA', data)
          break
        } catch (e) {
          if (!(e instanceof UplNoAnswer) || tryNo >= this.timing.chunkTries) throw e
        }
      }
      progress?.(Math.round((Math.min(off + chunk, id.imageLength) / id.imageLength) * 100))
    }
    await this.ask('UPL_END')
  }

  /**
   * Flash `target`: the staged image, or for UPL_TARGET.bridge with nothing staged the bundled one
   * (#367). `newNodeId` is UPL_TARGET.nodeIdKeep, or the NODE_ID to set first (#177). `status`
   * gets every UPL_STATUS. Resolves with the result — from UPL_RESULT, or from UPL_INFO_ACK when
   * that frame was lost — or `lost` when UPL_INFO goes unanswered (the port closed, or the Gateway
   * went): the Gateway finishes on its own, and `info()` / `follow()` pick it up again.
   *
   * A lost UPL_FLASH ACK can leave the Gateway flashing: with no answer, UPL_INFO is read, and a
   * Gateway that reads FLASHING is followed rather than reported as not started.
   * @throws UplRefused (BUSY, NOT_STAGED, NO_SESSION, BAD_INDEX) or UplNoAnswer: nothing started.
   */
  flash(target: number, newNodeId: number, status: (s: UplStatus) => void): Promise<FlashEnd> {
    return this.watch(status, async () => {
      try {
        await this.ask('UPL_FLASH', encodeFlash(target, newNodeId))
      } catch (e) {
        if (!(e instanceof UplNoAnswer) || (await this.info())?.state !== 'FLASHING') throw e
      }
    })
  }

  /**
   * Rejoin a flash that is already running (UPL_INFO_ACK `state` FLASHING): after the client lost
   * contact and came back, or a restart of the client. UPL_ABORT can't end it (BUSY), so a flow
   * waits it out here: its statuses, then its result, as `flash()` resolves.
   */
  follow(status: (s: UplStatus) => void): Promise<FlashEnd> {
    return this.watch(status)
  }

  /** Watch a flash after `start` (UPL_FLASH) until its result, or until contact is lost. */
  private async watch(
    status: (s: UplStatus) => void,
    start?: () => Promise<void>
  ): Promise<FlashEnd> {
    let finish!: (end: FlashEnd) => void
    const ended = new Promise<FlashEnd>((resolve) => (finish = resolve))
    // Listen before asking: the first UPL_STATUS follows the ACK at once.
    const off = this.link.onUnsolicited((f) => {
      if (f.type === UPL_TYPE.UPL_STATUS) {
        const s = decodeStatus(f.payload)
        this.log('upl.status', s)
        status(s)
      } else if (f.type === UPL_TYPE.UPL_RESULT) {
        const outcome = decodeResult(f.payload)
        this.log('upl.result', outcome)
        finish({ lost: false, outcome })
      }
    })
    try {
      await start?.()
    } catch (e) {
      off()
      throw e
    }
    let missed = 0
    const miss = () => {
      if (++missed < this.timing.lostAfter) return
      this.log('upl.lost', { missed })
      finish({ lost: true })
    }
    const probe = setInterval(() => {
      this.link
        .exchange(UPL_TYPE.UPL_INFO)
        .then((r) => {
          if (!r.ok) return miss()
          missed = 0
          const info = decodeInfoAck(r.frame.payload)
          // Not flashing any more, and no UPL_RESULT came first: it was lost; the answer holds it.
          if (info.state !== 'FLASHING') {
            const outcome = outcomeOf(info)
            this.log('upl.result', outcome)
            finish({ lost: false, outcome })
          }
        })
        // Any other failure of the channel (not a NACK or a silence) is a miss too, never an
        // unhandled rejection.
        .catch(miss)
    }, this.timing.probeMs)
    try {
      return await ended
    } finally {
      clearInterval(probe)
      off()
    }
  }

  /**
   * Drop whatever is staged or staging: before flashing the bundle (a board's leftover image would
   * be flashed instead), and when the dialog closes. While flashing the Gateway refuses it (BUSY):
   * a flash can't be stopped. `refused` / `no-answer` are told, never thrown.
   */
  async abort(): Promise<'ok' | 'busy' | 'no-answer'> {
    try {
      await this.ask('UPL_ABORT')
      return 'ok'
    } catch (e) {
      if (e instanceof UplNoAnswer) return 'no-answer'
      if (e instanceof UplRefused) return 'busy'
      throw e
    }
  }
}
