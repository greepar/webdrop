import { useEffect, useState } from 'react'
import { fetchRoomCapacity } from '@/features/room/api'
import { isAbortError, isApiError } from '@/shared/api/errors'
import type { RoomCapacity } from '@/shared/types/domain'

// Public room-count snapshot for the home page. Fetched once on mount; never polled.
// A 429/5xx or contract mismatch hides the counts instead of blocking entry.
export function useRoomCapacity() {
  const [capacity, setCapacity] = useState<RoomCapacity | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchRoomCapacity(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCapacity(value)
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        // 429 follows Retry-After by backing off once; otherwise the counts stay hidden.
        if (isApiError(err) && err.status === 429 && err.retryAfter) {
          const timer = window.setTimeout(() => {
            fetchRoomCapacity().then(setCapacity).catch(() => {})
          }, err.retryAfter * 1000)
          return () => window.clearTimeout(timer)
        }
      })
    return () => controller.abort()
  }, [])

  return capacity
}
