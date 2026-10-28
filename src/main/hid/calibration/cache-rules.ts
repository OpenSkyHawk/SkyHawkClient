// The client's copy of what the device confirmed it stored (#46, part 5). Pure — no Node, no
// Electron, no I/O — so every rule here is testable without a filesystem.
//
// **Why a copy exists at all.** Calibration lives in one 4 KB flash sector under a single CRC, and
// a commit erases the whole sector, so a power loss inside the ~28 ms erase window invalidates
// every axis rather than the one being written. Hardening the firmware was considered and declined
// in OpenSkyhawk#251: an 8-sector ring buffer is ~150 lines of flash management plus a
// reserved-region configuration that must match across every gateway project, to avoid a
// ten-minute annoyance. A client-side copy costs nearly nothing and covers more — a swapped
// gateway board, a reflash that wipes the sector, or simply wanting the previous numbers back.
//
// It is workable because the loss fails *closed*: a corrupt blob fails validation and the device
// reverts to identity passthrough, reporting `calibratedMask = 0` rather than serving garbage. The
// loss is always visible.

import type { CachedAxis, CachedBoard, CalCache, CalSnapshot } from '@shared/hid/calibration'

const CAL_CACHE_VERSION = 1

export function emptyCache(): CalCache {
  return { version: CAL_CACHE_VERSION, boards: {} }
}

const u16 = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535 ? v : undefined

/**
 * Parse whatever is on disk into something safe to act on.
 *
 * Hand-edited, truncated by a crash mid-write, or written by a future version — the file is not
 * trusted. Anything that does not survive validation is dropped rather than repaired, because a
 * repaired endpoint is a plausible wrong number, and this cache exists precisely to avoid pushing
 * plausible wrong numbers onto a device.
 */
export function sanitizeCache(raw: unknown): CalCache {
  const out = emptyCache()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Partial<CalCache>
  if (r.version !== CAL_CACHE_VERSION || !r.boards || typeof r.boards !== 'object') return out

  for (const [serial, board] of Object.entries(r.boards)) {
    if (!serial || !board || typeof board !== 'object') continue
    const b = board as Partial<CachedBoard>
    const axes: Record<number, CachedAxis> = {}
    for (const [key, axis] of Object.entries(b.axes ?? {})) {
      const idx = Number(key)
      if (!Number.isInteger(idx) || idx < 0 || idx > 7) continue
      const a = axis as Partial<CachedAxis>
      const min = u16(a.min)
      const centre = u16(a.centre)
      const max = u16(a.max)
      // The same ordering the device enforces on COMMIT. An entry that would be refused is worse
      // than no entry: it survives as far as the restore offer and fails at the wire.
      if (min === undefined || centre === undefined || max === undefined) continue
      if (!(min < centre && centre < max)) continue
      axes[idx] = { min, centre, max, selfCentring: a.selfCentring !== false }
    }
    if (Object.keys(axes).length === 0) continue
    out.boards[serial] = {
      confirmedAt: typeof b.confirmedAt === 'string' ? b.confirmedAt : '',
      axes
    }
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A config import's calibration section, read strictly (C1). calibration-cache.json is read
 * tolerantly (sanitizeCache: whatever does not survive is dropped), but an import must never read a
 * section that lost its structure as an empty copy. Its markers are the cache's own: `version`
 * (CAL_CACHE_VERSION) and `boards` (an object), and each board an object with its `confirmedAt`
 * date and an `axes` object. With those, the axes go through sanitizeCache as a local file's do:
 * an axis the device would refuse is dropped — never imported — and since an import only adds to
 * the copy (mergeCalibration), nothing already there is lost. `reason` completes
 * "Axis calibration: …".
 */
export function checkImportedCache(
  raw: unknown
): { ok: true; value: CalCache } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'it is not a settings section' }
  const v = raw.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, reason: 'it has no version' }
  }
  if (v > CAL_CACHE_VERSION) return { ok: false, reason: 'it was written by a newer client' }
  if (!isRecord(raw.boards)) return { ok: false, reason: 'it has no list of boards' }
  for (const [serial, board] of Object.entries(raw.boards)) {
    if (
      !serial ||
      !isRecord(board) ||
      typeof board.confirmedAt !== 'string' ||
      !isRecord(board.axes)
    ) {
      return { ok: false, reason: `its entry for board ${serial || '(no serial)'} is incomplete` }
    }
  }
  return { ok: true, value: sanitizeCache(raw) }
}

/** Record axes the device has confirmed storing. Merges — other axes on the board are untouched. */
export function storeAxes(
  cache: CalCache,
  serial: string,
  axes: Record<number, CachedAxis>,
  confirmedAt: string
): CalCache {
  if (!serial) return cache
  const existing = cache.boards[serial]
  return {
    ...cache,
    boards: {
      ...cache.boards,
      [serial]: { confirmedAt, axes: { ...existing?.axes, ...axes } }
    }
  }
}

/**
 * Forget one axis, or the whole board when `idx` is undefined.
 *
 * Called when the user deletes a calibration, and **only** then. A deliberate erase has to reach
 * the cache or the client would turn round and offer to restore exactly what was just deleted —
 * which is why deletion is a distinct event here rather than something inferred from a later read.
 */
export function dropAxis(cache: CalCache, serial: string, idx?: number): CalCache {
  const board = cache.boards[serial]
  if (!serial || !board) return cache
  const boards = { ...cache.boards }
  if (idx === undefined) {
    delete boards[serial]
    return { ...cache, boards }
  }
  const axes = { ...board.axes }
  delete axes[idx]
  if (Object.keys(axes).length === 0) delete boards[serial]
  else boards[serial] = { ...board, axes }
  return { ...cache, boards }
}

/**
 * The read-back rule for a write: the device reports the axis calibrated, with exactly the
 * endpoints written. The ACK only says "received"; this says "stored". The dialog's save and the
 * restore after a firmware update (#173) both judge a COMMIT by it.
 */
export function storedAsWritten(
  axis: CalSnapshot['axes'][number] | undefined,
  written: { min: number; centre: number; max: number }
): boolean {
  return (
    !!axis?.calibrated &&
    axis.min === written.min &&
    axis.centre === written.centre &&
    axis.max === written.max
  )
}

/** What this board has in the cache, or undefined — including when the serial is unknown. */
export function boardFor(cache: CalCache, serial?: string): CachedBoard | undefined {
  return serial ? cache.boards[serial] : undefined
}

/**
 * Axes the cache holds that the device has lost — the trigger for offering a restore.
 *
 * Deliberately narrow. Only an axis the device declares **present but uncalibrated** counts: a
 * slot this sketch no longer declares is not a loss, it is a different cockpit, and offering to
 * write calibration into a slot the device is not using would be noise at best.
 *
 * Returns nothing without a serial. That is the whole point of the key — TinyUSB reports the
 * RP2040's unique board ID, and without it there is no way to tell this board's calibration from
 * another's. Hall sensors vary per unit, which is why calibration exists at all, so guessing wrong
 * writes a plausible-looking calibration that is wrong for the hardware. That fails *open*, which
 * is worse than the uncalibrated state it replaced: uncalibrated is visible, wrong-calibrated is
 * not.
 */
export function regressedAxes(cache: CalCache, snapshot?: CalSnapshot): number[] {
  const board = boardFor(cache, snapshot?.serialNumber)
  if (!board || !snapshot) return []
  return Object.keys(board.axes)
    .map(Number)
    .filter((idx) => {
      const a = snapshot.axes[idx]
      return !!a?.present && !a.calibrated
    })
    .sort((a, b) => a - b)
}

/**
 * Calibration merges into the client's copy per board serial: the axes the file has replace the
 * same axes, every other cached axis and board is kept. The board's date is the newer of the two.
 */
export function mergeCalibration(cache: CalCache, imported: CalCache): CalCache {
  const boards = { ...cache.boards }
  for (const [serial, board] of Object.entries(imported.boards)) {
    const cur = boards[serial]
    const confirmedAt =
      cur && cur.confirmedAt > board.confirmedAt ? cur.confirmedAt : board.confirmedAt
    boards[serial] = { confirmedAt, axes: { ...cur?.axes, ...board.axes } }
  }
  return { ...cache, boards }
}
