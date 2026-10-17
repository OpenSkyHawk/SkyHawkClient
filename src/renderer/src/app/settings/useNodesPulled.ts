import { useEffect, useState } from 'react'
import { useNodesStore } from '../../nodes'

/**
 * Whether a Settings section has its node data yet. What it shows comes from main's snapshot
 * (cockpit:snapshot settings, R3.2b); this keeps the moment it first shows it. Each section pulled
 * the node data when it mounted (`nodes:get`) and showed nothing until the reply — or a newer
 * `nodes:model` push — landed: the same pull, the same wait, the same frame without data.
 */
export function useNodesPulled(): boolean {
  const pushed = useNodesStore((s) => s.nodeModel)
  const [atMount] = useState(pushed)
  const [pulled, setPulled] = useState(false)
  useEffect(() => {
    const pull = useNodesStore.getState().pullNodes()
    if (!pull) return
    let live = true
    void pull.then(() => {
      if (live) setPulled(true)
    })
    return () => {
      live = false
    }
  }, [])
  return pulled || pushed !== atMount
}
