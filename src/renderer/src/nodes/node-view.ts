// Cockpit board wording and the search box (R3.2): presentation over the pushed snapshot. The
// board's state, flag and readings are main's (cockpit:snapshot); this only draws and filters them.
import type { NodeState, NodeView } from '@shared/nodes'

/** Never colour alone: every state but healthy / unknown carries a symbol. */
export const STATE_SYMBOL: Record<NodeState, string> = {
  on: '',
  warn: '!',
  off: '✕',
  new: '+',
  unknown: ''
}

/** A tile is lit when it matches the search (name or NODE_ID) and, with Issues on, has one. */
export function tileMatches(v: NodeView, query: string, issuesOnly: boolean): boolean {
  if (issuesOnly && (v.health.state === 'on' || v.health.state === 'unknown')) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return v.entry.name.toLowerCase().includes(q) || String(v.entry.nodeId) === q.replace(/^#/, '')
}
