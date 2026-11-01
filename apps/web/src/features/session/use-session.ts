import { useCallback, useEffect, useRef, useState } from 'react'
import { createOrRestoreSession, fetchSession, renameSession } from '@/features/room/api'
import { defaultDeviceName, deviceNameError } from '@/features/session/device-name'
import { isAbortError, isApiError } from '@/shared/api/errors'
import type { MemberRole, Membership, Session } from '@/shared/types/domain'

export type SessionState =
  | { phase: 'loading' }
  // Last known good session while a re-read is failing; UI keeps recoverable rooms visible.
  | { phase: 'ready-stale'; session: Session; message: string }
  | { phase: 'ready'; session: Session }
  | { phase: 'error'; message: string }

// Establishes or restores the anonymous device session. Membership roles come only from the server
// (`memberships[].membership.role`); nothing here decides authorization on the client.
//
// Lifecycle: the last ready session is retained during loading and network errors, so the home page
// keeps showing recoverable rooms. A new fetch only replaces it on success; only an explicit
// refresh starts from loading. Local cache never grants access: RoomPage still revalidates the
// snapshot and membership before showing room content.
export function useSession() {
  const [state, setState] = useState<SessionState>({ phase: 'loading' })
  const [version, setVersion] = useState(0)
  const lastReady = useRef<Session | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const load = async (stale: Session | null) => {
      try {
        let session: Session
        try {
          session = await fetchSession(controller.signal)
        } catch (error) {
          if (!isApiError(error) || error.status !== 401) throw error
          // New device: suggest a readable "Browser · OS" name. The server stores it; the user
          // can rename later. Falls back to the server default when generation yields nothing.
          await createOrRestoreSession(defaultDeviceName(), controller.signal)
          session = await fetchSession(controller.signal)
        }
        // One-time migration: sessions created before device names existed all read "Device".
        // Rename once to the browser guess; a user-chosen name (anything else) is never touched.
        // localStorage guards repeats across tabs; the server value always wins on conflict.
        if (!controller.signal.aborted && isGenericName(session.displayName) && !localStorage.getItem(MIGRATED_KEY)) {
          localStorage.setItem(MIGRATED_KEY, '1')
          try {
            const renamed = await renameSession(defaultDeviceName(), controller.signal)
            if (renamed) session = renamed
          } catch {
            // Backend without PATCH /session yet, or rate-limited: keep "Device", retry next load.
            localStorage.removeItem(MIGRATED_KEY)
          }
          session = await fetchSession(controller.signal).catch(() => session)
        }
        if (!controller.signal.aborted) {
          lastReady.current = session
          setState({ phase: 'ready', session })
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        // 401 means the session is gone: it must not keep presenting old memberships as recoverable.
        if (isApiError(error) && error.status === 401) lastReady.current = null
        if (stale) {
          setState({ phase: 'ready-stale', session: stale, message: staleMessage(error) })
          return
        }
        setState({ phase: 'error', message: staleMessage(error) })
      }
    }
    void load(lastReady.current)
    return () => controller.abort()
  }, [version])

  const refresh = useCallback(() => {
    setState((current) => {
      if (current.phase === 'ready' || current.phase === 'ready-stale') {
        return { phase: 'ready-stale', session: current.session, message: '正在重新连接' }
      }
      if (lastReady.current) {
        return { phase: 'ready-stale', session: lastReady.current, message: '正在重新连接' }
      }
      return { phase: 'loading' }
    })
    setVersion((n) => n + 1)
  }, [])

  // Rename the current device. Pessimistic: the server value wins; on failure the UI keeps
  // the old name and reports the error to the caller.
  const rename = useCallback(async (displayName: string): Promise<{ ok: boolean; message?: string }> => {
    const invalid = deviceNameError(displayName)
    if (invalid) return { ok: false, message: invalid }
    try {
      const session = await renameSession(displayName.trim())
      if (!session) return { ok: false, message: '操作未完成，请重试' }
      lastReady.current = session
      setState({ phase: 'ready', session })
      return { ok: true }
    } catch (error) {
      if (isApiError(error) && error.status === 429) {
        return { ok: false, message: error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试' }
      }
      return { ok: false, message: '改名未成功，请重试' }
    }
  }, [])

  // Other tabs changed memberships (leave/close/kick/approve): the server stays authoritative, so just
  // request a re-read. Keep the last good session so a broadcast never wipes a valid recovery list.
  useEffect(() => {
    const notify = () => {
      refresh()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_SYNC_KEY) notify()
    }
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(SESSION_SYNC_KEY) : null
    channel?.addEventListener('message', notify)
    window.addEventListener('storage', onStorage)
    return () => {
      channel?.close()
      window.removeEventListener('storage', onStorage)
    }
  }, [refresh])
  return { state, refresh, rename }
}

export const SESSION_SYNC_KEY = 'webdrop-session-sync'

// Broadcasts "memberships may have changed" to other tabs. Fire-and-forget: every receiver re-reads
// GET /session from the server, never trusts the sender's copy.
export function notifySessionChanged() {
  try {
    if ('BroadcastChannel' in window) new BroadcastChannel(SESSION_SYNC_KEY).postMessage('changed')
    localStorage.setItem(SESSION_SYNC_KEY, String(Date.now()))
  } catch {
    // Storage or BroadcastChannel may be blocked; the current tab already re-reads directly.
  }
}

function staleMessage(error: unknown): string {
  if (isApiError(error) && error.status === 429) {
    return `连接请求过于频繁，${error.retryAfter ? `${error.retryAfter} 秒后` : '请稍后'}重试`
  }
  return '无法建立连接，请重试'
}

// Names the backend assigns when the client sends nothing. Only these are auto-migrated;
// anything the user (or a previous migration) set is left alone.
function isGenericName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return normalized === '' || normalized === 'device' || normalized === '本机设备'
}

const MIGRATED_KEY = 'webdrop-device-renamed'

// Finds the caller's membership in one room, or null if they are not a member.
export function findMembership(session: Session | null, roomId: string): Membership | null {
  return session?.memberships.find((m) => m.room.id === roomId) ?? null
}

export function roleOf(membership: Membership | null): MemberRole | null {
  return membership ? membership.membership.role : null
}
