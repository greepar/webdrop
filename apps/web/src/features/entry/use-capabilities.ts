import { useCallback, useEffect, useState } from 'react'
import { fetchCapabilities } from '@/features/room/api'
import { isAbortError } from '@/shared/api/errors'
import type { Capabilities } from '@/shared/types/domain'

// Public, unauthenticated capabilities (code length, limits). Limits shown in the UI come from here,
// never from hard-coded constants.
export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [error, setError] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchCapabilities(controller.signal)
      .then((value) => {
        setError(false)
        setCapabilities(value)
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(true)
      })
    return () => controller.abort()
  }, [version])

  const retry = useCallback(() => setVersion((n) => n + 1), [])
  return { capabilities, error, retry }
}
