/// <reference lib="webworker" />
import { solve, type SolveInput } from '@/shared/pow/protocol'

type Incoming = { type: 'solve'; id: number; request: SolveInput } | { type: 'cancel'; id: number }

// Each solve id has its own cancel flag so a stale cancel can never affect a newer task.
const cancelled = new Set<number>()

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data
  if (message.type === 'cancel') {
    cancelled.add(message.id)
    return
  }
  try {
    const nonce = await solve(message.request, () => cancelled.has(message.id))
    cancelled.delete(message.id)
    if (nonce === null) return
    self.postMessage({ type: 'solved', id: message.id, nonce })
  } catch (error) {
    cancelled.delete(message.id)
    self.postMessage({ type: 'failed', id: message.id, reason: error instanceof Error ? error.message : 'unknown' })
  }
}
