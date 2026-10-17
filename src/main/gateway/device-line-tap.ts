// The device line tap: the Gateway's byte stream, below the calibration frame filter, assembled
// into text lines and read — never changed. Node lines go to the node layer (NodeHub, through the
// NodeLineSink port), and every line is handed on to its subscribers (Session logs the panel
// commands). The bytes the relay sends to DCS are GatewayConnection's onBytes(), untouched by this.
import { LineAssembler, parseCommand } from './link-framing'
import type { LinkRider } from './gateway-connection'

/** One complete text line from the device, below the calibration de-mux. */
export interface DeviceLine {
  /** `node` lines are tapped to the roster / node layer; `command` lines are panel commands. */
  kind: 'node' | 'command'
  identifier: string
  arg: string
  line: string
  t: number
}

/** Where node lines go (nodes NodeHub implements it): gateway never imports nodes. */
export interface NodeLineSink {
  /** The raw line with any UART noise in front of a node-status row cut off. */
  cleanLine(raw: string): string
  /** One parsed line. True when it was a node line, tapped by the node layer. */
  nodeLine(identifier: string, arg: string, line: string, t: number): boolean
}

type Unsubscribe = () => void

export class DeviceLineTap implements LinkRider {
  private assembler = new LineAssembler()
  private readonly lineCbs = new Set<(line: DeviceLine) => void>()

  constructor(private readonly nodes: NodeLineSink) {}

  /** Every complete text line, after the node layer has seen it. */
  onLine(cb: (line: DeviceLine) => void): Unsubscribe {
    this.lineCbs.add(cb)
    return () => this.lineCbs.delete(cb)
  }

  /** The port opened (LinkRider): a line cut by the unplug must not prefix the next one. */
  opening(): void {
    this.assembler = new LineAssembler()
  }

  /** Device bytes, calibration frames already removed (GatewayConnection.onBytes). */
  push(rest: Buffer): void {
    const t = Date.now()
    for (const raw of this.assembler.push(rest)) {
      if (!raw.trim()) continue
      // UART noise from a bridge reset can precede the first node-status row; cut it off.
      const line = this.nodes.cleanLine(raw)
      const { identifier, arg } = parseCommand(line)
      let kind: DeviceLine['kind'] = 'command'
      // Node-status and node-telemetry messages are tapped, not logged as panel commands.
      if (this.nodes.nodeLine(identifier, arg, line.trim(), t)) kind = 'node'
      for (const cb of this.lineCbs) cb({ kind, identifier, arg, line: line.trim(), t })
    }
  }
}
