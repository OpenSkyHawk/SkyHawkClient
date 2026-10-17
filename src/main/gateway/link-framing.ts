// DCS-BIOS line framing on the SimGateway link (pure, no Node/Electron deps): the command lines
// the device sends, and the export frame the client injects. The gateway and nodes topics both
// need these, so they live here rather than in dcs (arch-phase0-v2 OQ2).

/**
 * Encode a single 16-bit DCS-BIOS export write as a self-contained frame:
 * sync (4×0x55) + address(LE) + count=2(LE) + value(LE). Used to inject the
 * node-roster request into the export stream sent to the SimGateway.
 */
export function encodeExportFrame(address: number, value: number): Uint8Array {
  return new Uint8Array([
    0x55,
    0x55,
    0x55,
    0x55,
    address & 0xff,
    (address >> 8) & 0xff,
    0x02,
    0x00,
    value & 0xff,
    (value >> 8) & 0xff
  ])
}

/** Split "IDENTIFIER ARG" into its parts (first space separates). */
export function parseCommand(line: string): { identifier: string; arg: string } {
  const i = line.indexOf(' ')
  return i === -1
    ? { identifier: line, arg: '' }
    : { identifier: line.slice(0, i), arg: line.slice(i + 1) }
}

/** Accumulates ASCII bytes and yields complete newline-terminated lines (CR stripped). */
export class LineAssembler {
  private buf = ''

  push(bytes: Uint8Array): string[] {
    for (let i = 0; i < bytes.length; i++) this.buf += String.fromCharCode(bytes[i]!)
    const lines: string[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      lines.push(this.buf.slice(0, idx).replace(/\r$/, ''))
      this.buf = this.buf.slice(idx + 1)
    }
    return lines
  }
}
