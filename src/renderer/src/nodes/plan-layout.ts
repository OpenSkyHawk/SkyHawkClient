// The Cockpit plan's geometry (R3.2): where main's power zones (cockpit:snapshot plan) are drawn —
// group and tile positions, tile widths, the background boxes, the PSU box and the feed lines.
// Which boards are drawn, in which zone and on which console is main's; this only lays them out.
import type { ConsoleKey, NodeView, PduOutage, PlanConsole, PlanGroupHead } from '@shared/nodes'

/** Stage geometry, in the 1000-wide stage the plan scales to fit. */
export const STAGE_W = 1000
const MIN_STAGE_H = 600
const CONSOLES: Record<
  ConsoleKey,
  { title: string; x: number; titleY: number; top: number; w: number; cols: number; wide: boolean }
> = {
  L: { title: 'Left console', x: 40, titleY: 164, top: 186, w: 200, cols: 2, wide: false },
  C: { title: 'Instrument panel', x: 290, titleY: 100, top: 122, w: 420, cols: 4, wide: true },
  R: { title: 'Right console', x: 760, titleY: 164, top: 186, w: 200, cols: 2, wide: false }
}
const TILE_GAP = 8
const ROW_H = 42
/** Tile labels are mono 11 px: about 0.6 em a character. */
const CHAR_W = 6.6
/**
 * Left inset and padding, gap and border around the label, plus room for the state symbol — always
 * reserved, so a board changing state never changes its tile's width or re-wraps its group.
 */
const TILE_CHROME = 46

/**
 * A tile fits its label (#93): never narrower than the console's column (`min`), at most `max`
 * (~2 columns, or the whole group on a side console); past that the label ends in "…". Its width
 * depends on the name only, never on the board's state.
 */
export function tileWidth(label: string, min: number, max: number): number {
  const fit = Math.ceil(label.length * CHAR_W + TILE_CHROME)
  return Math.min(max, Math.max(min, fit))
}
const HINT_H = 16
const GROUP_GAP = 10

export interface PlanTile {
  view: NodeView
  /** Name without its console prefix (`Left_Fuel` → `Fuel`). */
  short: string
  x: number
  y: number
  w: number
}

export interface PlanGroup {
  key: string
  /** The PDU heading this group; null = nodes with no power zone on this console. */
  pdu: NodeView | null
  /** The PDU's header (main's). */
  head?: PlanGroupHead
  console: ConsoleKey
  x: number
  y: number
  w: number
  wide: boolean
  tiles: PlanTile[]
  outage?: PduOutage
  /** Under the tiles of a PDU that went down with its nodes. */
  hint?: { text: string; y: number }
}

export interface PlanWire {
  d: string
  /** The PDU feeding this line raises a rail flag. */
  alert: boolean
}

export interface PlanLayout {
  height: number
  consoles: { key: ConsoleKey; title: string; sub: string; x: number; y: number }[]
  /** Background shapes, sized to the content. */
  sideBox: { y: number; h: number }
  centerBottom: number
  psu: { x: number; y: number }
  groups: PlanGroup[]
  wires: PlanWire[]
}

/** Name without its console prefix (`Left_Fuel` → `Fuel`). */
/** The tile label: the console prefix goes, however it is joined (`Center_`, `Center `, `Center-`). */
export const shortName = (name: string) => name.replace(/^(Left|Center|Right)[_\s-]+(?=\S)/i, '')

export function outageHint(o: PduOutage): string {
  const n = o.nodeIds.length
  const who =
    n === o.fedCount
      ? n === 1
        ? 'The only node'
        : `All ${n} nodes`
      : `${n} of ${o.fedCount} nodes`
  const how = n === 1 ? 'lost power with it' : 'lost power together'
  return `${who} on this PDU ${how} — a blown 5 V fuse at the PDU looks like this.`
}

/**
 * Main's zones, console by console, laid out top to bottom: each group's header, then its tiles,
 * which fit their names and wrap within their group (#93), then the outage hint.
 */
export function planLayout(plan: PlanConsole[]): PlanLayout {
  const groups: PlanGroup[] = []
  const bottom: Record<ConsoleKey, number> = { L: 0, C: 0, R: 0 }

  for (const pc of plan) {
    const key = pc.key
    const c = CONSOLES[key]
    const tileW = Math.floor((c.w - TILE_GAP * (c.cols - 1)) / c.cols)
    const maxW = Math.min(2 * tileW + TILE_GAP, c.w)
    let y = c.top
    for (const z of pc.zones) {
      const outage = z.outage
      const g: PlanGroup = {
        key: z.key,
        pdu: z.pdu,
        head: z.head,
        console: key,
        x: c.x,
        y,
        w: c.w,
        wide: c.wide,
        tiles: [],
        outage
      }
      y += c.wide ? 30 : 44
      // Tiles flow left to right and wrap inside the group, each as wide as its label needs.
      let x = c.x
      let row = 0
      for (const view of z.members) {
        const short = shortName(view.entry.name)
        const w = tileWidth(short, tileW, maxW)
        if (x > c.x && x + w > c.x + c.w) {
          x = c.x
          row++
        }
        g.tiles.push({ view, short, x, y: y + row * ROW_H, w })
        x += w + TILE_GAP
      }
      y += (z.members.length ? row + 1 : 0) * ROW_H
      if (outage) {
        g.hint = { text: outageHint(outage), y: y - 4 }
        y += HINT_H
      }
      y += GROUP_GAP
      groups.push(g)
    }
    bottom[key] = y
  }

  // Background boxes grow with the content; the PSU sits under the lowest of them.
  const sideBottom = Math.max(530, bottom.L + 14, bottom.R + 14)
  const centerBottom = Math.max(374, bottom.C + 14)
  const psuY = Math.max(548, sideBottom + 18, centerBottom + 18)
  const height = Math.max(MIN_STAGE_H, psuY + 52)
  const psu = { x: 420, y: psuY }

  // One feed line per PDU, gold while it raises a rail flag (main's `feeds`).
  const wires: PlanWire[] = []
  for (const pc of plan) {
    const key = pc.key
    const on = pc.feeds
    on.forEach((alert, i) => {
      const off = i - (on.length - 1) / 2
      if (key === 'C') {
        const x = Math.round(500 + off * 70)
        wires.push({ d: `M${x} ${psuY} V${centerBottom}`, alert })
      } else {
        const x = Math.round((key === 'L' ? 140 : 860) + off * 24)
        const from = key === 'L' ? psu.x : psu.x + 160
        wires.push({ d: `M${from} ${psuY + 18 - i * 8} H${x} V${sideBottom + 2}`, alert })
      }
    })
  }

  const count = (key: ConsoleKey) => plan.find((pc) => pc.key === key)?.feeds.length ?? 0
  return {
    height,
    consoles: (['L', 'C', 'R'] as const).map((key) => ({
      key,
      title: CONSOLES[key].title,
      sub: count(key) > 1 ? `${count(key)} PDUs` : '',
      x: CONSOLES[key].x,
      y: CONSOLES[key].titleY
    })),
    sideBox: { y: 150, h: sideBottom - 150 },
    centerBottom,
    psu,
    groups,
    wires
  }
}
