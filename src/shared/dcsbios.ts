// Pure DCS-BIOS export-protocol parser (no Node/Electron deps, fully testable).
//
// The export stream is a sequence of 16-bit writes, framed as:
//   [sync: 0x55 0x55 0x55 0x55] [addrLo addrHi] [countLo countHi] [data... countBytes]
// then repeating [addr][count][data] blocks until the next sync. Each 16-bit data
// word is written to `address`, then address += 2, until `count` bytes consumed.
// Four consecutive 0x55 bytes always force the start of a new frame (resync).
//
// This mirrors the canonical DCS-BIOS Arduino ProtocolParser state machine.

export const EXPORT_MULTICAST_ADDR = '239.255.50.10'
export const EXPORT_PORT = 5010
export const COMMAND_PORT = 7778

/** DCS-BIOS common-metadata address of the null-terminated aircraft name. */
export const ACFT_NAME_ADDRESS = 0x0000
export const ACFT_NAME_MAX = 24

const enum State {
  WaitForSync,
  AddressLow,
  AddressHigh,
  CountLow,
  CountHigh,
  DataLow,
  DataHigh
}

export type WriteHandler = (address: number, value: number) => void

export class DcsBiosProtocol {
  private state: State = State.WaitForSync
  private address = 0
  private count = 0
  private data = 0
  private syncRun = 0
  private readonly onWrite: WriteHandler

  constructor(onWrite: WriteHandler) {
    this.onWrite = onWrite
  }

  reset(): void {
    this.state = State.WaitForSync
    this.address = 0
    this.count = 0
    this.data = 0
    this.syncRun = 0
  }

  processBuffer(buf: Uint8Array): void {
    for (let i = 0; i < buf.length; i++) this.processByte(buf[i]!)
  }

  processByte(b: number): void {
    switch (this.state) {
      case State.AddressLow:
        this.address = b
        this.state = State.AddressHigh
        break
      case State.AddressHigh:
        this.address |= b << 8
        this.state = State.CountLow
        break
      case State.CountLow:
        this.count = b
        this.state = State.CountHigh
        break
      case State.CountHigh:
        this.count |= b << 8
        this.state = State.DataLow
        break
      case State.DataLow:
        this.data = b
        this.state = State.DataHigh
        break
      case State.DataHigh:
        this.data |= b << 8
        this.onWrite(this.address, this.data)
        this.address += 2
        this.count -= 2
        this.state = this.count === 0 ? State.AddressLow : State.DataLow
        break
      case State.WaitForSync:
        break
    }

    // Resync: four consecutive 0x55 bytes start a fresh frame on the next byte.
    if (b === 0x55) {
      this.syncRun++
      if (this.syncRun === 4) {
        this.state = State.AddressLow
        this.syncRun = 0
      }
    } else {
      this.syncRun = 0
    }
  }
}

/**
 * Reconstruct a null-terminated ASCII string from DCS-BIOS string-region writes.
 * Each 16-bit word holds two characters: low byte at `offset`, high byte at `offset+1`.
 */
export class StringRegion {
  private readonly buf: Uint8Array
  private readonly base: number

  constructor(base: number, length: number) {
    this.base = base
    this.buf = new Uint8Array(length)
  }

  /** Apply a write; returns true if it touched this region. */
  update(address: number, value: number): boolean {
    const off = address - this.base
    if (off < 0 || off >= this.buf.length) return false
    this.buf[off] = value & 0xff
    if (off + 1 < this.buf.length) this.buf[off + 1] = (value >> 8) & 0xff
    return true
  }

  value(): string {
    let end = this.buf.indexOf(0)
    if (end === -1) end = this.buf.length
    let s = ''
    for (let i = 0; i < end; i++) s += String.fromCharCode(this.buf[i]!)
    return s.trim()
  }
}

/** Build a DCS-BIOS command line ("IDENTIFIER ARG\n"). */
export function formatCommand(identifier: string, arg: string | number): string {
  return `${identifier} ${arg}\n`
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
