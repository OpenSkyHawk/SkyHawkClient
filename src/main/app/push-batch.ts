// One IPC message per main turn (R3.4c): every push made during one synchronous run goes out as a
// single `push:batch`.
//
// Main decides; the renderer draws what it is told. When one main event fans out to several
// pushes (a link change: `device:status`, `cal:workflow`, `cockpit:snapshot`, `relay:facts`), each
// sent as its own IPC message, the renderer committed between them and could show part of the
// change — the link down while the Cockpit still reads live. Batched, they arrive as one message,
// the preload hands them to their subscribers in one task, and React draws them as one frame.
//
// The flush is a microtask queued at a turn's first push: after the turn's synchronous code, so
// every push of that turn is in it, and before anything the turn scheduled with a timer or I/O —
// so no push waits on a timer. An intent's reply is sent from a continuation queued once its
// handler returns or its promise settles, after the pushes the handler made, so a push still
// reaches the renderer ahead of the reply that follows it, as it did when each push was sent at
// once. The order of the pushes, and each payload, are main's own; nothing is merged or dropped.
import type { Emit, PushBatch, PushItem } from '@shared/app'

/** An `Emit` that collects each turn's pushes and hands them to `send` as one batch. */
export function batchPushes(send: (batch: PushBatch) => void): Emit {
  let turn: PushItem[] | undefined
  return (channel, payload) => {
    if (!turn) {
      const batch: PushItem[] = (turn = [])
      queueMicrotask(() => {
        turn = undefined
        send(batch)
      })
    }
    turn.push({ channel, payload } as PushItem)
  }
}
