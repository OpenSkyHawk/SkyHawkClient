// SESSION-seam contract test (Phase 0, row B107): the DCS link transports, against real sockets
// on 127.0.0.1 where the OS allows it deterministically (TCP to host, unicast listen), and against
// a stand-in socket for the loopback multicast join (whether a CI runner can join a multicast
// group is not ours to pin). What a transport reports — export chunks, errors, connected — is
// recorded in order, the way the relay hears it.
import dgram from 'node:dgram'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import { EXPORT_MULTICAST_ADDR, EXPORT_PORT } from '@shared/dcs'
import { createTransport, type Transport } from './transports'

/** Everything a transport reported, in order. */
function record(t: Transport): string[] {
  const log: string[] = []
  t.onExport((chunk) => log.push(`export ${chunk.toString('hex')}`))
  t.onError((err) => log.push(`error ${(err as NodeJS.ErrnoException).code ?? err.message}`))
  t.onConnected((up) => log.push(`connected ${up}`))
  return log
}

/** Let real I/O run (setImmediate is never faked here) until `cond` holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = performance.now() + 3000
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

/** Let real I/O run for a while, for "nothing more happens" checks. */
async function settle(ms = 50): Promise<void> {
  const end = performance.now() + ms
  while (performance.now() < end) await new Promise((r) => setImmediate(r))
}

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const config = (patch: Partial<AppConfig>): AppConfig => ({ ...DEFAULT_CONFIG, ...patch })

// ── TCP to host ──────────────────────────────────────────────────────────────

/** A DCS-BIOS stand-in listening on 127.0.0.1: the sockets it accepted and what it read. */
async function dcsServer() {
  const accepted: net.Socket[] = []
  const received: Buffer[] = []
  const server = net.createServer((sock) => {
    accepted.push(sock)
    sock.on('data', (d) => received.push(d))
    sock.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const close = () => {
    for (const s of accepted) s.destroy()
    server.close()
  }
  cleanup.push(close)
  return { port, accepted, received, close }
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

describe('B107 TCP to host', () => {
  it('connects to host:commandPort, carries export in and commands out on one socket', async () => {
    const dcs = await dcsServer()
    const t = createTransport(config({ transport: 'tcp-to-host', commandPort: dcs.port }))
    const log = record(t)
    t.start()
    await until(() => log.includes('connected true') && dcs.accepted.length === 1, 'connect')

    dcs.accepted[0]!.write(Buffer.from([0x55, 0x55, 0x55, 0x55, 1, 2]))
    await until(() => log.length === 2, 'export')
    t.send(Buffer.from('MASTER_ARM 1\n'))
    await until(() => dcs.received.length > 0, 'the command')
    expect(Buffer.concat(dcs.received).toString()).toBe('MASTER_ARM 1\n')

    t.stop()
    // Stop destroys the socket; its close is still reported, after Stop returns.
    expect(log).toEqual(['connected true', 'export 555555550102'])
    await until(() => log.length === 3, 'the close')
    expect(log).toEqual(['connected true', 'export 555555550102', 'connected false'])
    t.send(Buffer.from('X 1\n')) // after Stop: dropped, no throw
    await settle()
    expect(dcs.accepted).toHaveLength(1)
  })

  it('queues a command sent while connecting and delivers it once connected', async () => {
    const dcs = await dcsServer()
    const t = createTransport(config({ transport: 'tcp-to-host', commandPort: dcs.port }))
    record(t)
    t.start()
    t.send(Buffer.from('EARLY 1\n'))
    await until(() => dcs.received.length > 0, 'the queued command')
    expect(Buffer.concat(dcs.received).toString()).toBe('EARLY 1\n')
    t.stop()
  })

  it('reconnects 2 s after DCS drops it, for as long as the relay runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dcs = await dcsServer()
    const t = createTransport(config({ transport: 'tcp-to-host', commandPort: dcs.port }))
    const log = record(t)
    t.start()
    await until(() => log.includes('connected true') && dcs.accepted.length === 1, 'connect')

    dcs.accepted[0]!.destroy() // DCS closes the socket (mission end, DCS quit)
    await until(() => log.length === 2, 'the drop')
    expect(log).toEqual(['connected true', 'connected false'])
    vi.advanceTimersByTime(1999)
    await settle()
    expect(dcs.accepted, 'no retry before 2 s').toHaveLength(1)
    vi.advanceTimersByTime(1)
    await until(() => log.length === 3 && dcs.accepted.length === 2, 'the reconnect')
    expect(log).toEqual(['connected true', 'connected false', 'connected true'])
    t.stop()
  })

  it('a refused connect is an error then a close, retried every 2 s until Stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const port = await closedPort()
    const t = createTransport(config({ transport: 'tcp-to-host', commandPort: port }))
    const log = record(t)
    t.start()
    await until(() => log.length === 2, 'the refusal')
    expect(log, 'never connected, so a close without an up').toEqual([
      'error ECONNREFUSED',
      'connected false'
    ])
    vi.advanceTimersByTime(2000)
    await until(() => log.length === 4, 'the retry')
    expect(log.slice(2)).toEqual(['error ECONNREFUSED', 'connected false'])

    t.stop() // the next retry is pending: Stop cancels it
    vi.advanceTimersByTime(10_000)
    await settle()
    expect(log).toHaveLength(4)
  })

  it('a relay started against a DCS that comes up later connects on a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const port = await closedPort()
    const t = createTransport(config({ transport: 'tcp-to-host', commandPort: port }))
    const log = record(t)
    t.start()
    await until(() => log.length === 2, 'the refusal')
    const server = net.createServer((s) => s.on('error', () => {}))
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
    cleanup.push(() => server.close())
    vi.advanceTimersByTime(2000)
    await until(() => log.length === 3, 'the connect')
    expect(log).toEqual(['error ECONNREFUSED', 'connected false', 'connected true'])
    t.stop()
    await until(() => log.length === 4, 'the close')
    vi.advanceTimersByTime(10_000)
    await settle()
    expect(log.at(-1), 'no retry after Stop').toBe('connected false')
    expect(log).toHaveLength(4)
  })
})

// ── unicast listen ───────────────────────────────────────────────────────────

/** A free UDP port on 127.0.0.1, and a socket bound to it (closed after the test) if `hold`. */
async function udpPort(hold = false) {
  const s = dgram.createSocket('udp4')
  const received: Buffer[] = []
  s.on('message', (m) => received.push(m))
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r))
  const port = s.address().port
  if (hold) cleanup.push(() => s.close())
  else await new Promise<void>((r) => s.close(r))
  return { port, received }
}

function sendTo(port: number, data: Buffer): Promise<void> {
  const s = dgram.createSocket('udp4')
  return new Promise((r) => s.send(data, port, '127.0.0.1', () => (s.close(), r())))
}

describe('B107 unicast listen', () => {
  it('listens on listenPort, reports listening as connected, and sends to host:commandPort', async () => {
    const { port: listenPort } = await udpPort()
    const dcs = await udpPort(true) // DCS-BIOS's import port
    const t = createTransport(
      config({ transport: 'unicast-listen', listenPort, commandPort: dcs.port })
    )
    const log = record(t)
    t.start()
    expect(log, 'bind is asynchronous').toEqual([])
    await until(() => log.length === 1, 'the bind')
    expect(log).toEqual(['connected true'])

    await sendTo(listenPort, Buffer.from([0x55, 0x55, 0x55, 0x55, 9]))
    await until(() => log.length === 2, 'export')
    expect(log[1]).toBe('export 5555555509')
    t.send(Buffer.from('GEAR 1\n'))
    await until(() => dcs.received.length === 1, 'the command')
    expect(dcs.received[0]!.toString()).toBe('GEAR 1\n')

    t.stop()
    expect(log.at(-1), 'Stop reports the close itself, synchronously').toBe('connected false')
    expect(log).toHaveLength(3)
    t.send(Buffer.from('X 1\n')) // after Stop: dropped, no throw
    await settle()
    expect(dcs.received).toHaveLength(1)
  })

  it('shares the listen port with another reuseAddr listener (DCS-BIOS tools coexist)', async () => {
    const { port: listenPort } = await udpPort()
    const other = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    await new Promise<void>((r) => other.bind(listenPort, r))
    cleanup.push(() => other.close())
    const t = createTransport(config({ transport: 'unicast-listen', listenPort }))
    const log = record(t)
    t.start()
    await until(() => log.length === 1, 'the bind')
    expect(log).toEqual(['connected true'])
    t.stop()
  })

  it('a port held exclusively is an error, never connected', async () => {
    const held = dgram.createSocket({ type: 'udp4', reuseAddr: false })
    await new Promise<void>((r) => held.bind(0, r))
    cleanup.push(() => held.close())
    const t = createTransport(
      config({ transport: 'unicast-listen', listenPort: held.address().port })
    )
    const log = record(t)
    t.start()
    await until(() => log.length === 1, 'the bind error')
    expect(log).toEqual(['error EADDRINUSE'])
    await settle()
    expect(log).toEqual(['error EADDRINUSE'])
    t.stop() // the relay's Stop after the error: no throw, and the close is reported
    expect(log).toEqual(['error EADDRINUSE', 'connected false'])
  })
})

// ── loopback multicast ───────────────────────────────────────────────────────

/** Stands in for the dgram socket: records the calls the transport makes on it. */
class FakeSocket extends EventEmitter {
  calls: string[] = []
  membershipError?: Error
  bind(port: number, cb: () => void) {
    this.calls.push(`bind ${port}`)
    queueMicrotask(cb)
  }
  addMembership(addr: string) {
    this.calls.push(`addMembership ${addr}`)
    if (this.membershipError) throw this.membershipError
  }
  send(data: Buffer, port: number, host: string) {
    this.calls.push(`send ${data.toString('hex')} ${host}:${port}`)
  }
  close() {
    this.calls.push('close')
  }
}

function fakeDgram(): { sock: FakeSocket; opts: unknown[] } {
  const sock = new FakeSocket()
  const opts: unknown[] = []
  vi.spyOn(dgram, 'createSocket').mockImplementation(((o: unknown) => {
    opts.push(o)
    return sock
  }) as unknown as typeof dgram.createSocket)
  return { sock, opts }
}

describe('B107 loopback multicast', () => {
  it(`binds the export port with reuseAddr, joins ${EXPORT_MULTICAST_ADDR}, then reports connected`, async () => {
    const { sock, opts } = fakeDgram()
    const t = createTransport(
      config({
        transport: 'loopback-multicast',
        listenPort: 1,
        commandPort: 7778,
        host: '10.0.0.9'
      })
    )
    const log = record(t)
    t.start()
    expect(opts).toEqual([{ type: 'udp4', reuseAddr: true }])
    expect(sock.calls, 'the export port, not listenPort').toEqual([`bind ${EXPORT_PORT}`])
    expect(log).toEqual([])
    await Promise.resolve()
    expect(sock.calls).toEqual([`bind ${EXPORT_PORT}`, `addMembership ${EXPORT_MULTICAST_ADDR}`])
    expect(log).toEqual(['connected true'])

    sock.emit('message', Buffer.from([0x55, 1]))
    sock.emit('error', new Error('socket hiccup'))
    t.send(Buffer.from([0x41, 0x0a]))
    expect(sock.calls.at(-1), 'commands go to host:commandPort').toBe('send 410a 10.0.0.9:7778')
    t.stop()
    expect(sock.calls.at(-1)).toBe('close')
    expect(log).toEqual(['connected true', 'export 5501', 'error socket hiccup', 'connected false'])
    t.send(Buffer.from([1])) // after Stop: dropped
    expect(sock.calls.at(-1)).toBe('close')
  })

  it('a failed group join is reported as an error, and it still reports connected', async () => {
    const { sock } = fakeDgram()
    sock.membershipError = new Error('addMembership EADDRNOTAVAIL')
    const t = createTransport(config({ transport: 'loopback-multicast' }))
    const log = record(t)
    t.start()
    await Promise.resolve()
    expect(log).toEqual(['error addMembership EADDRNOTAVAIL', 'connected true'])
    t.stop()
  })
})
