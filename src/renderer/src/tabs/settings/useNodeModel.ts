import { useEffect, useState } from 'react'
import type { NodeModel } from '@shared/nodes/ipc'

/**
 * The latest `nodes:model` while the caller is mounted: fetched once, then followed. Settings
 * reads the node data layer (#61) directly over its IPC rather than keeping a copy in the store.
 */
export function useNodeModel(): NodeModel | undefined {
  const [model, setModel] = useState<NodeModel>()
  useEffect(() => {
    const api = window.skyhawk
    if (!api) return
    let live = true
    void api.getNodes().then((s) => {
      if (live) setModel(s.model)
    })
    const off = api.on('nodes:model', setModel)
    return () => {
      live = false
      off()
    }
  }, [])
  return model
}
