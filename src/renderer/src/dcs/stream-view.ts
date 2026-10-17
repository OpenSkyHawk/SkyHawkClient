// Log tab › Stream (R3.4b): the stream rows as the store keeps them, and their raw bytes (pure).
import { hex2 } from '@shared/format'

export type DirFilter = 'all' | 'in' | 'out'

export interface LogRow {
  id: number
  time: string
  dir: 'in' | 'out'
  name: string
  addrHex: string
  value: number | string
  raw: string
}

export function rawHex(addr: number, value: number | string): string {
  const v = typeof value === 'number' ? Math.abs(value) & 0xffff : 0
  return `${hex2(addr >> 8)} ${hex2(addr)} ${hex2(v)} ${hex2(v >> 8)}`
}
