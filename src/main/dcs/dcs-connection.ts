// The network end of the relay: the link to DCS-BIOS over loopback multicast, unicast listen or
// TCP to host (transports.ts), which reconnects on its own. One transport at a time; a transport
// being replaced or stopped is stale, and what it reports after that is ignored.
import { createTransport, type Transport, type TransportOptions } from './transports'

/** What the DCS link reports, as the relay hears it. */
export interface DcsLinkEvents {
  export(chunk: Buffer): void
  error(err: Error): void
  connected(connected: boolean): void
}

export class DcsConnection {
  private transport?: Transport

  /** Build the transport for these settings and subscribe to it. Nothing is opened until start(). */
  open(cfg: TransportOptions, on: DcsLinkEvents): void {
    const t = createTransport(cfg)
    this.transport = t
    t.onExport((chunk) => on.export(chunk))
    t.onError((err) => {
      if (this.transport !== t) return
      on.error(err)
    })
    t.onConnected((connected) => {
      if (this.transport !== t) return // a transport being stopped reports its own close
      on.connected(connected)
    })
  }

  /** Bind or dial the transport open() built. */
  start(): void {
    this.transport?.start()
  }

  stop(): void {
    const t = this.transport
    this.transport = undefined // first, so its closing callbacks are recognised as stale
    t?.stop()
  }

  /** Device traffic to DCS (its import port, or the TCP socket). */
  send(data: Buffer): void {
    this.transport?.send(data)
  }
}
