import { describe, expect, it } from 'vitest'
import { deliverPushes, type PushBatch, type PushChannel } from '@shared/app'
import { batchPushes } from './push-batch'

const STATS = {
  bytesInPerSec: 0,
  bytesOutPerSec: 0,
  framesPerSec: 0,
  commandsPerSec: 0,
  commandsTotal: 0,
  errors: 0,
  uptimeSec: 0,
  reconnects: 0
}

/** A batching emit over a recording `send`. */
function rig() {
  const sent: PushBatch[] = []
  const emit = batchPushes((b) => sent.push(b))
  return { sent, emit }
}

const channels = (b: PushBatch) => b.map((p) => p.channel)

describe('batchPushes (R3.4c)', () => {
  it('sends every push of one turn as one batch, in the order main made them', async () => {
    const { sent, emit } = rig()
    emit('device:status', { state: 'connected' } as never)
    emit('cal:workflow', { tab: {} } as never)
    emit('cockpit:snapshot', { rev: 1 } as never)
    emit('relay:facts', { mode: 'bridge' } as never)
    expect(sent).toEqual([]) // nothing leaves before the turn is over
    await Promise.resolve()
    expect(sent.map(channels)).toEqual([
      ['device:status', 'cal:workflow', 'cockpit:snapshot', 'relay:facts']
    ])
  })

  it('keeps each payload as given, a channel pushed twice included (the later one last)', async () => {
    const { sent, emit } = rig()
    const first = { tab: { n: 1 } } as never
    const second = { tab: { n: 2 } } as never
    emit('cal:workflow', first)
    emit('cal:workflow', second)
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]!.payload).toBe(first)
    expect(sent[0]![1]!.payload).toBe(second)
  })

  it('a push in a later turn — a timer, or after an await — is a batch of its own', async () => {
    const { sent, emit } = rig()
    emit('stats:tick', STATS)
    await Promise.resolve()
    emit('stats:tick', STATS)
    await new Promise((r) => setTimeout(r, 0))
    emit('relay:state', { running: true })
    await Promise.resolve()
    expect(sent.map(channels)).toEqual([['stats:tick'], ['stats:tick'], ['relay:state']])
  })

  it('goes out ahead of the reply an intent handler returns after pushing', async () => {
    // ipcMain.handle replies from a continuation on the handler's result: after this flush.
    const { sent, emit } = rig()
    const order: string[] = []
    const handler = async () => {
      emit('relay:state', { running: true })
      return { ok: true }
    }
    const reply = Promise.resolve(handler()).then(() => order.push(`reply after ${sent.length}`))
    await reply
    expect(order).toEqual(['reply after 1'])
  })

  it('waits on no timer: the batch is out before a zero-delay timeout fires', async () => {
    const { sent, emit } = rig()
    let atTimer = -1
    setTimeout(() => (atTimer = sent.length), 0)
    emit('relay:state', { running: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(atTimer).toBe(1)
  })
})

describe('deliverPushes (R3.4c)', () => {
  it('hands each push to its channel’s subscribers, in the batch’s order', () => {
    const seen: string[] = []
    const subs = new Map<PushChannel, ((p: never) => void)[]>([
      ['device:status', [() => seen.push('status a'), () => seen.push('status b')]],
      ['relay:facts', [() => seen.push('facts')]]
    ])
    const batch = [
      { channel: 'relay:facts', payload: {} },
      { channel: 'device:status', payload: {} },
      { channel: 'stats:tick', payload: STATS }, // nobody subscribed: skipped
      { channel: 'relay:facts', payload: {} }
    ] as PushBatch
    deliverPushes(batch, (ch) => subs.get(ch))
    expect(seen).toEqual(['facts', 'status a', 'status b', 'facts'])
  })

  it('a subscriber that throws costs only its own push; the error is rethrown at the end', () => {
    const seen: string[] = []
    const boom = new Error('boom')
    const subs = new Map<PushChannel, ((p: never) => void)[]>([
      [
        'device:status',
        [
          () => {
            throw boom
          }
        ]
      ],
      ['relay:facts', [() => seen.push('facts')]]
    ])
    const batch = [
      { channel: 'device:status', payload: {} },
      { channel: 'relay:facts', payload: {} }
    ] as PushBatch
    expect(() => deliverPushes(batch, (ch) => subs.get(ch))).toThrow(boom)
    expect(seen).toEqual(['facts'])
  })
})
