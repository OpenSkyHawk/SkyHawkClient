import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the real port that records what happened to it.
 *
 * The bug this file exists for is entirely about instance lifetime — how many ports get built,
 * and whether the old ones are released — so this counts instances and tracks disposal rather
 * than simulating any I/O.
 */
class FakePort {
  static built: FakePort[] = []
  static present = true
  isOpen = false
  destroyed = false
  listeners = 0
  private openCb?: (err?: Error) => void
  private handlers = new Map<string, (arg?: unknown) => void>()

  constructor(_opts: unknown) {
    FakePort.built.push(this)
  }

  static list() {
    return Promise.resolve(
      FakePort.present ? [{ path: 'COM3', vendorId: '2e8a', productId: '4134' }] : []
    )
  }

  on(ev: string, cb: (arg?: unknown) => void) {
    this.handlers.set(ev, cb)
    this.listeners++
  }
  removeAllListeners() {
    this.handlers.clear()
    this.listeners = 0
  }
  /** Fire an event the driver would raise. A disposed port has nothing bound and stays silent. */
  emit(ev: string, arg?: unknown) {
    this.handlers.get(ev)?.(arg)
  }
  hasHandler(ev: string) {
    return this.handlers.has(ev)
  }
  open(cb: (err?: Error) => void) {
    this.openCb = cb
  }
  /**
   * The real `close` is asynchronous and calls back once the OS handle is actually released.
   *
   * Modelling that is the point: a double that released synchronously could not tell a reopen
   * which waits for the handle from one which does not, and that is exactly the difference
   * between recovering and failing with "Access denied" on Windows.
   */
  close(cb?: () => void) {
    this.isOpen = false
    if (cb) setImmediate(cb)
  }
  destroy() {
    this.destroyed = true
  }
  /** Complete the pending open, as the driver would. */
  settle(err?: Error) {
    this.isOpen = !err
    this.openCb?.(err)
  }
}

vi.mock('serialport', () => ({ SerialPort: FakePort }))
vi.mock('./debug', () => ({ debugLog: () => {} }))

const { SerialBridge } = await import('./serial')

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('SerialBridge port lifetime', () => {
  beforeEach(() => {
    FakePort.built = []
    FakePort.present = true
  })

  it('releases a port completely on stop', async () => {
    // Reassigning the field is not enough. The old instance keeps its listeners — so its own
    // close goes on scheduling retries — and on Windows it keeps the OS handle, so the process
    // blocks its own reopen. That is the access-denied-on-COM3 report: retrying never clears it,
    // only stopping the relay does, because that is what finally releases the handles.
    const s = new SerialBridge(true)
    s.start()
    await flush()
    const first = FakePort.built[0]!
    first.settle()
    expect(first.listeners).toBeGreaterThan(0)

    s.stop()
    // A no-op 'error' handler is deliberately left bound so a late error from the dying handle
    // cannot reach a listener-less stream, which Node escalates to an uncaught exception. What
    // must be gone are the handlers that drive the bridge.
    expect(first.hasHandler('close'), 'close unbound').toBe(false)
    expect(first.hasHandler('data'), 'data unbound').toBe(false)
    expect(first.destroyed, 'not destroyed until the close completes').toBe(false)
    await flush() // let the close call back, as the driver would
    expect(first.destroyed, 'and the handle released').toBe(true)
  })

  it('disposes the old port before building the next one', async () => {
    // The failure mode: every retry built a port over the top of the last. Each orphan kept its
    // handle and its close listener, so retries multiplied and handles accumulated — which is why
    // the permission error grew likelier the longer it ran, and why only stopping the relay
    // cleared it.
    // Fake timers from the start: the retry is scheduled by the close handler, so switching
    // afterwards would leave that timer on the real clock and it would never fire here.
    vi.useFakeTimers()
    const s = new SerialBridge(true)
    s.start()
    await vi.advanceTimersByTimeAsync(0) // let the port enumeration resolve
    const first = FakePort.built[0]!
    first.settle()

    first.emit('close') // the cable goes
    await vi.advanceTimersByTimeAsync(2100) // the retry fires; the device is back
    vi.useRealTimers()

    expect(FakePort.built.length, 'a second port was built').toBe(2)
    expect(first.destroyed, 'and the first was released first').toBe(true)
    expect(first.hasHandler('close'), 'so its close can no longer schedule retries').toBe(false)
    s.stop()
  })

  it('leaves exactly one reconnect pending, however many handlers fire', () => {
    // A single disconnect reaches retry() twice — the open fails, then close fires — and retry()
    // used to assign over a pending timer, which does not cancel it. Two timers, two openLoops,
    // two ports, two more handles, every cycle. That is why the permission error grew likelier
    // the longer it ran.
    //
    // Counting pending timers rather than ports built: it is the timer pile-up itself that is
    // being guarded, and asserting on ports lets the other guard mask a regression here.
    vi.useFakeTimers()
    const s = new SerialBridge(true)
    s.start()
    return vi.advanceTimersByTimeAsync(0).then(() => {
      const first = FakePort.built[0]!
      first.settle(new Error('access denied')) // open failed: schedules a retry
      first.emit('close') // and close: a second path to the same retry
      expect(vi.getTimerCount(), 'one reconnect pending, not two').toBe(1)
      s.stop()
      expect(vi.getTimerCount(), 'and stopping cancels it').toBe(0)
      vi.useRealTimers()
    })
  })
})
