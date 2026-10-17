// SESSION-seam tests for the roster poll and the Gateway's "not responding" deadline (#132: M2,
// G1, M3, M7 and the removed Refresh), through the services harness: a simulated PanelBridge
// answers the roster requests the app writes, and the test reads only pushes, intents and files.
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import { eventText } from '@shared/format'
import type { NodeMappingFile } from '@shared/nodes'
import { statusLine } from '../../test-fixtures/nodes'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { nodeRosterRequest } = await import('../nodes/node-status-wire')
const REQUEST = Buffer.from(nodeRosterRequest()).toString('latin1')
/** Boards 1 and 2 are in your cockpit. */
const COCKPIT = {
  'node-mapping.json': { version: 4, nodes: { 1: { added: true }, 2: { added: true } } }
}
/** Boards 1–4 are in your cockpit: the soak's bus. */
const SOAK_COCKPIT = {
  'node-mapping.json': {
    version: 4,
    nodes: { 1: { added: true }, 2: { added: true }, 3: { added: true }, 4: { added: true } }
  }
}
const STEP_MS = 50

const iso = (ms: number) => new Date(ms).toISOString()
const lastSeen = (app: Services, id: number) =>
  app.files.json<NodeMappingFile>('node-mapping.json')?.nodes[id]?.lastSeen

/** A seeded PRNG (mulberry32): the same soak every run. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface BridgeModel {
  /** The reply to the n-th roster request (0 = the seed on connect) is lost. */
  lost?: (n: number, now: number) => boolean
  /** How long the n-th reply takes to start arriving. */
  delay?: (n: number) => number
  /** The gap between one reply line and the next. */
  gap?: () => number
  /**
   * The longest the bridge leaves a request without any line back, while it answers at all: a
   * late reply is brought forward to this. Unset: no limit.
   */
  answerWithinMs?: number
  /**
   * One line of the n-th reply lost on the way (#132): the index into its lines (0 = the node-0
   * row, the last = `_NODE_STATUS_END`), or undefined to send it whole.
   */
  dropLine?: (n: number, lines: number) => number | undefined
}

/**
 * PanelBridge as the wire shows it: every roster request it reads is answered with one unbroken
 * burst — its own node-0 row, a row per board, `_NODE_STATUS_END <count>` — in the order asked,
 * each line arriving on its own, so a request can land in the middle of a reply.
 */
function bridge(app: Services, boards: number[], model: BridgeModel = {}) {
  const PANEL = 0x01
  const PDU = 0x02
  const kind = (id: number) => (id >= 3 && id <= 5 ? PDU : PANEL) // NODE_IDS.md: 3–5 are PDUs
  let asked = 0
  let dropped = 0
  let lastLineAt = 0
  /** The first request since the last line sent: what the app's not-responding clock counts from. */
  let waitingSince: number | undefined
  const lines: { at: number; text: string }[] = []
  const burst = [
    statusLine(0, true, 3),
    ...boards.map((id) => statusLine(id, true, kind(id))),
    `_NODE_STATUS_END ${boards.length + 1}\n`
  ]
  return {
    /** Requests read so far. */
    get asked() {
      return asked
    },
    /** Reply lines lost on the way so far (dropLine). */
    get dropped() {
      return dropped
    },
    /** Read what the app wrote, and send every reply line that is due. */
    step(): void {
      const now = app.clock.now()
      const n = app.serial.writtenText().split(REQUEST).length - 1
      app.serial.clearWritten()
      for (let i = 0; i < n; i++, asked++) {
        waitingSince ??= now
        if (model.lost?.(asked, now)) continue
        let at = now + (model.delay?.(asked) ?? 5)
        if (model.answerWithinMs !== undefined) {
          at = Math.min(at, waitingSince + model.answerWithinMs)
        }
        at = Math.max(at, lastLineAt) // one serial line: replies arrive in the order asked
        const drop = model.dropLine?.(asked, burst.length)
        for (const [i, text] of burst.entries()) {
          if (i === drop) {
            dropped++
            continue
          }
          lines.push({ at, text })
          lastLineAt = at
          at += model.gap?.() ?? 0
        }
      }
      while (lines.length && lines[0].at <= now) {
        app.serial.receive(lines.shift()!.text)
        waitingSince = undefined
      }
    }
  }
}

/** Run the app and the bridge together for `ms`, in STEP_MS steps; `each` sees every step. */
function run(app: Services, b: ReturnType<typeof bridge>, ms: number, each?: () => void): void {
  for (let t = 0; t < ms; t += STEP_MS) {
    app.clock.advance(STEP_MS)
    b.step()
    each?.()
  }
}

const notResponding = (app: Services) =>
  app.lastPush('device:status')?.gateway?.kind === 'not-responding'

describe('G1 one lost roster reply never reads as "Gateway not responding"', () => {
  it('the poll’s reply is lost: it is asked again within a second, and nothing flashes', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    // Request 0 is the seed on connect, 1 the first 5 s poll: that reply is lost.
    const b = bridge(app, [1, 2], { lost: (n) => n === 1 })
    app.serial.open()
    let lostAt: number | undefined
    let reaskAt: number | undefined
    run(app, b, 30_000, () => {
      if (b.asked === 2 && lostAt === undefined) lostAt = app.clock.now()
      if (b.asked === 3 && reaskAt === undefined) reaskAt = app.clock.now()
    })
    expect(app.pushesOf('device:status').some((s) => s.gateway?.kind === 'not-responding')).toBe(
      false
    )
    expect(
      app.invoke(CTRL.eventsGet).filter((e) => /not responding|responding again/.test(eventText(e)))
    ).toEqual([])
    // The re-ask follows the lost poll by a second (one 200 ms tick of slack), not the next poll.
    expect(reaskAt! - lostAt!).toBeLessThanOrEqual(1000 + 200 + STEP_MS)
  })

  it('a real outage still raises it: within 5.2 s of the first unanswered request', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    const outage: { from?: number } = {}
    const b = bridge(app, [1, 2], {
      lost: (_n, now) => outage.from !== undefined && now >= outage.from
    })
    app.serial.open()
    run(app, b, 12_000)
    const silentFrom = app.clock.now()
    outage.from = silentFrom // the Gateway stops answering, its port still open
    const askedBefore = b.asked
    let firstUnanswered: number | undefined
    let raisedAt: number | undefined
    run(app, b, 20_000, () => {
      if (b.asked > askedBefore) firstUnanswered ??= app.clock.now()
      if (notResponding(app)) raisedAt ??= app.clock.now()
    })
    expect(raisedAt, 'raised').toBeDefined()
    // The bound: the next poll (≤ 5 s) + the 5 s deadline + one 200 ms tick.
    expect(raisedAt! - silentFrom).toBeLessThanOrEqual(5000 + 5000 + 200 + STEP_MS)
    expect(raisedAt! - firstUnanswered!).toBeGreaterThanOrEqual(5000 - STEP_MS)
    expect(raisedAt! - firstUnanswered!).toBeLessThanOrEqual(5000 + 200 + STEP_MS)
    expect(b.asked - askedBefore, 'asked again every second meanwhile').toBeGreaterThanOrEqual(5)
  })
})

describe('soak: 30 simulated minutes of lost and late replies (M2, G1, the #290 gate)', () => {
  it('no board ever reads offline, nothing is re-saved, and "not responding" never flashes', () => {
    const app = makeServices({ paths: { files: SOAK_COCKPIT } })
    const rnd = random(290)
    // Below the loss threshold: a reply is lost a quarter of the time but never more than two in
    // a row, and the bridge never leaves a request unanswered for 4.5 s — so the Gateway is never
    // silent for the 5 s deadline. Some replies come seconds late and trickle in, so later
    // requests (the 5 s poll, re-asks) land while one is still arriving: what M2 is about.
    let lostInRow = 0
    const b = bridge(app, [1, 2, 3, 4], {
      lost: () => {
        const lost = lostInRow < 2 && rnd() < 0.25
        lostInRow = lost ? lostInRow + 1 : 0
        return lost
      },
      delay: () => {
        const r = rnd()
        return r < 0.6 ? 2 + rnd() * 48 : r < 0.85 ? 800 + rnd() * 800 : 2500 + rnd() * 2000
      },
      gap: () => (rnd() < 0.85 ? rnd() * 40 : 100 + rnd() * 200),
      answerWithinMs: 4500,
      // #132: one in five replies loses a single line on the way — a board's row, the node-0 row
      // or the END — so its END count no longer matches what arrived.
      dropLine: (_n, lines) => (rnd() < 0.2 ? Math.floor(rnd() * lines) : undefined)
    })
    app.serial.open()
    // Until the first answer arms the re-ask, only the 5 s poll asks: two lost in a row, then a
    // late answer, is 14.5 s. Every board is online by then.
    run(app, b, 16_000)
    const seen = () => [1, 2, 3, 4].map((id) => lastSeen(app, id))
    const onlineAt = seen()
    expect(onlineAt.every(Boolean), 'all came online').toBe(true)

    let offline: string | undefined
    let flashed = false
    run(app, b, 30 * 60_000, () => {
      flashed ||= notResponding(app)
      const m = app.lastPush('nodes:model')
      for (const n of m?.nodes ?? []) {
        if (n.availability !== 'online') offline ??= `${n.nodeId} at ${app.clock.now()}`
      }
    })

    expect(offline, 'a false offline').toBeUndefined()
    expect(flashed, 'a "not responding" flash').toBe(false)
    expect(b.asked, 'the poll and its re-asks kept asking').toBeGreaterThan(360)
    expect(b.dropped, 'single lines were lost inside replies').toBeGreaterThan(50)
    expect(seen(), 'no extra saves').toEqual(onlineAt)
    const events = app.invoke(CTRL.eventsGet)
    expect(
      events.filter((e) => e.source === 'node' && e.nodeId !== undefined).map(eventText),
      'no board went offline or came back'
    ).toEqual([])
    expect(events.map(eventText).filter((r) => /responding/.test(r))).toEqual([])
  })
})

describe('M3 a v2 Gateway’s roster END completes nothing', () => {
  it('your boards stay unknown, not offline, so Hide and Forget stay refused', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    const v2 = '_NODE_STATUS 01010000000000000080000000\n' // 26 hex: no nodeKind
    app.serial.open()
    app.serial.receive(v2 + '_NODE_STATUS_END 1\n')
    app.clock.advance(200)
    const model = app.invoke(CTRL.nodesGet).model
    expect(model.rosterComplete).toBe(false)
    expect(model.nodes.map((n) => [n.nodeId, n.availability])).toEqual([
      [1, 'unknown'],
      [2, 'unknown']
    ])
    expect(app.invoke(CTRL.nodeMappingHide, 2, true).ok).toBe(false)
    expect(app.invoke(CTRL.nodeMappingForget, 2).ok).toBe(false)
  })
})

describe('M7 Retry after an error saves last seen, as Disconnect, unplug and quit do (B13)', () => {
  it('the boards on the bus were last seen at the Retry', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    app.serial.receive(statusLine(0, true, 3) + statusLine(1) + '_NODE_STATUS_END 2\n')
    app.clock.advance(200) // the link flush: it came online
    const cameOnline = app.clock.now()
    expect(lastSeen(app, 1)).toBe(iso(cameOnline))
    app.clock.advance(3000)
    app.serial.fail('EIO') // the port fails while open
    expect(app.lastPush('device:status')?.state).toBe('error')
    app.clock.advance(1000)
    const retryAt = app.clock.now()
    app.invoke(CTRL.deviceConnect) // Retry
    expect(lastSeen(app, 1)).toBe(iso(retryAt))
  })
})

describe('Refresh is gone; the poll still asks (#132)', () => {
  it('no nodes:refresh intent, and the 5 s poll writes the roster request', () => {
    expect(Object.values(CTRL)).not.toContain('nodes:refresh')
    const app = makeServices()
    app.serial.open()
    app.serial.clearWritten()
    app.clock.advance(5000)
    expect(app.serial.writtenText()).toContain(REQUEST)
  })
})
