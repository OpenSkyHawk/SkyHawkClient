// DCS-BIOS network transports (main process). Pure Node dgram/net — the live
// source for Monitor and Bridge modes. The parser/decoder consume `onExport`
// without caring which transport produced the bytes.
import dgram from 'node:dgram'
import net from 'node:net'
import { EXPORT_MULTICAST_ADDR, EXPORT_PORT } from '@shared/dcsbios'
import type { AppConfig } from '@shared/ipc'

export interface Transport {
  start(): void
  stop(): void
  /** Send a DCS-BIOS command/import payload toward DCS. */
  send(data: Buffer): void
  onExport(cb: (chunk: Buffer) => void): void
  onError(cb: (err: Error) => void): void
  onConnected(cb: (connected: boolean) => void): void
}

abstract class BaseTransport implements Transport {
  protected exportCb: (chunk: Buffer) => void = () => {}
  protected errorCb: (err: Error) => void = () => {}
  protected connectedCb: (connected: boolean) => void = () => {}

  abstract start(): void
  abstract stop(): void
  abstract send(data: Buffer): void

  onExport(cb: (chunk: Buffer) => void): void {
    this.exportCb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }
  onConnected(cb: (connected: boolean) => void): void {
    this.connectedCb = cb
  }
}

/** Export over UDP — either loopback multicast join or a plain unicast listen. */
class UdpTransport extends BaseTransport {
  private sock?: dgram.Socket
  private readonly cfg: AppConfig
  private readonly multicast: boolean

  constructor(cfg: AppConfig, multicast: boolean) {
    super()
    this.cfg = cfg
    this.multicast = multicast
  }

  start(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock
    sock.on('error', (err) => this.errorCb(err))
    sock.on('message', (msg) => this.exportCb(msg))
    const bindPort = this.multicast ? EXPORT_PORT : this.cfg.listenPort
    sock.bind(bindPort, () => {
      if (this.multicast) {
        try {
          sock.addMembership(EXPORT_MULTICAST_ADDR)
        } catch (err) {
          this.errorCb(err as Error)
        }
      }
      this.connectedCb(true)
    })
  }

  stop(): void {
    this.connectedCb(false)
    this.sock?.close()
    this.sock = undefined
  }

  send(data: Buffer): void {
    this.sock?.send(data, this.cfg.commandPort, this.cfg.host)
  }
}

/** Export + commands over a single bidirectional TCP socket to <host>:7778 (remote DCS). */
class TcpTransport extends BaseTransport {
  private sock?: net.Socket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly cfg: AppConfig

  constructor(cfg: AppConfig) {
    super()
    this.cfg = cfg
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  private connect(): void {
    const sock = net.connect(this.cfg.commandPort, this.cfg.host)
    this.sock = sock
    sock.on('connect', () => this.connectedCb(true))
    sock.on('data', (chunk) => this.exportCb(chunk))
    sock.on('error', (err) => this.errorCb(err))
    sock.on('close', () => {
      this.connectedCb(false)
      if (!this.stopped && this.cfg.autoReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000)
      }
    })
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.sock?.destroy()
    this.sock = undefined
  }

  send(data: Buffer): void {
    this.sock?.write(data)
  }
}

export function createTransport(cfg: AppConfig): Transport {
  switch (cfg.transport) {
    case 'loopback-multicast':
      return new UdpTransport(cfg, true)
    case 'unicast-listen':
      return new UdpTransport(cfg, false)
    case 'tcp-to-host':
      return new TcpTransport(cfg)
  }
}
