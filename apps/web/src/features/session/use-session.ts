import { useCallback, useEffect, useState } from 'react'
import { createOrRestoreSession, fetchSession } from '@/features/room/api'
import { isAbortError, isApiError } from '@/shared/api/errors'
import type { MemberRole, Membership, Session } from '@/shared/types/domain'

export type SessionState =
  | { phase: 'loading' }
  | { phase: 'ready'; session: Session }
  | { phase: 'error'; message: string }

// Establishes or restores the anonymous device session. Membership roles come only from the server
// (`memberships[].membership.role`); nothing here decides authorization on the client.
export function useSession() {
  const [state, setState] = useState<SessionState>({ phase: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        let session: Session
        try {
          session = await fetchSession(controller.signal)
        } catch (error) {
          if (!isApiError(error) || error.status !== 401) throw error
          await createOrRestoreSession(undefined, controller.signal)
          session = await fetchSession(controller.signal)
        }
        if (!controller.signal.aborted) setState({ phase: 'ready', session })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        const message = isApiError(error) && error.status === 429
          ? `连接请求过于频繁，${error.retryAfter ? `${error.retryAfter} 秒后` : '请稍后'}重试`
          : '无法建立连接，请重试'
        setState({ phase: 'error', message })
      }
    }
    void load()
    return () => controller.abort()
  }, [version])

  const refresh = useCallback(() => {
    setState({ phase: 'loading' })
    setVersion((n) => n + 1)
  }, [])
  return { state, refresh }
}

// Finds the caller's membership in one room, or null if they are not a member.
export function findMembership(session: Session | null, roomId: string): Membership | null {
  return session?.memberships.find((m) => m.room.id === roomId) ?? null
}

export function roleOf(membership: Membership | null): MemberRole | null {
  return membership ? membership.membership.role : null
}
