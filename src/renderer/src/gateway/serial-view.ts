// Serial tab (R3.4b: cut from Serial.tsx): a frame's bytes as hex and ASCII (pure).
const MAX_BYTES = 48 // truncate very long chunks in the display

export function render(hex: string): { hex: string; ascii: string; more: number } {
  const bytes = Math.floor(hex.length / 2)
  const shown = Math.min(bytes, MAX_BYTES)
  let h = ''
  let a = ''
  for (let i = 0; i < shown; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2)
    const b = parseInt(pair, 16)
    h += (i ? ' ' : '') + pair.toUpperCase()
    a += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
  }
  return { hex: h, ascii: a, more: bytes - shown }
}
