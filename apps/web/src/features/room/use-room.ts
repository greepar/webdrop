import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError, isApiError } from '@/shared/api/errors'
import { env } from '@/shared/config/env'
import { fetchItems, fetchMembers, fetchRoomSnapshot } from '@/features/room/api'
import { subscribeRoomEvents, type RoomEventStream } from '@/features/room/room-events'
import type { Member, RoomItem, RoomSnapshot } from '@/shared/types/domain'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'mock'

export type RoomState = {
  room: RoomSnapshot | null
  members: Member[]
  items: RoomItem[]
  nextCursor: string | null
  loading: boolean
  error: { code: string; message: string } | null
  // True when the server rejected the membership (kicked, closed, or session expired).
  gone: boolean
  // Items that arrived after the initial snapshot; only these get the short entrance fade.
  freshIds: string[]
  connection: ConnectionState
  // Bumped on every join-request SSE arrival so the owner badge refreshes even when the
  // dialog (and its own poll) is not mounted. The count itself still comes from the list API.
  joinRequestTick: number
}

// Snapshot first (room, members, newest page), then subscribe from the snapshot's eventCursor. Items are
// keyed by id, so an event that repeats after a reconnect never produces a second message.
async function loadSnapshot(roomId: string, signal?: AbortSignal, oldestId?: string) {
  const room = await fetchRoomSnapshot(roomId, signal)
  const [members, page] = await Promise.all([
    fetchMembers(roomId, signal),
    fetchItems(roomId, null, signal),
  ])
  const items = new Map(page.items.map(item => [item.id, item]))
  let nextCursor = page.nextCursor
  const cursors = new Set<string>()
  while (oldestId && !items.has(oldestId) && nextCursor) {
    if (cursors.has(nextCursor)) throw new Error('Repeated history cursor')
    cursors.add(nextCursor)
    const older = await fetchItems(roomId, nextCursor, signal)
    older.items.forEach(item => items.set(item.id, item))
    nextCursor = older.nextCursor
  }
  return { room, members, items: [...items.values()].reverse(), nextCursor }
}

export function useRoom(roomId: string) {
  const [state, setState] = useState<RoomState>({
    room: null,
    members: [],
    items: [],
    nextCursor: null,
    loading: true,
    error: null,
    gone: false,
    connection: 'idle',
    freshIds: [],
    joinRequestTick: 0,
  })
  const seen = useRef(new Set<string>())
  const deleted = useRef(new Set<string>())
  const snapshotGeneration = useRef(0)
  const [reloadToken, setReloadToken] = useState(0)
  const oldestLoaded = useRef<string | undefined>(undefined)
  useEffect(() => { oldestLoaded.current = state.items[0]?.id }, [state.items])

  const addItems = useCallback((incoming: RoomItem[]) => {
    const fresh = incoming.filter((item) => {
      if (seen.current.has(item.id) || deleted.current.has(item.id)) return false
      seen.current.add(item.id)
      return true
    })
    if (fresh.length === 0) return
    setState((prev) => ({ ...prev, items: sortItems([...prev.items, ...fresh]), freshIds: fresh.map((item) => item.id) }))
  }, [])

  const streamRef = useRef<RoomEventStream | null>(null)
  const reconnectTimer = useRef(0)

  const membersRequest = useRef<AbortController | null>(null)
  const detailsRequest = useRef<AbortController | null>(null)
  const reloadMembers = useCallback(() => {
    membersRequest.current?.abort()
    const controller = new AbortController()
    membersRequest.current = controller
    fetchMembers(roomId, controller.signal)
      .then((members) => {
        if (!controller.signal.aborted) setState((prev) => ({ ...prev, members }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (isApiError(error) && [401, 403, 404, 410].includes(error.status)) {
          streamRef.current?.close()
          setState((prev) => ({ ...prev, gone: true, connection: 'idle' }))
        }
      })
  }, [roomId])

  // Holds the live stream so a resync or unmount can close it. Mock mode has no stream by design.

  const subscribeFrom = useCallback((cursor: string) => {
    streamRef.current?.close()
    if (env.isMock) {
      setState((prev) => ({ ...prev, connection: 'mock' }))
      return
    }
    streamRef.current = subscribeRoomEvents(roomId, cursor, {
      onItemCreated: (item) => addItems([item]),
      onItemDeleted: (itemId) => {
        deleted.current.add(itemId)
        seen.current.delete(itemId)
        setState((prev) => ({ ...prev, items: prev.items.filter((i) => i.id !== itemId) }))
      },
      onMembersChanged: reloadMembers,
      onJoinRequestChanged: () => {
        setState((prev) => ({ ...prev, joinRequestTick: prev.joinRequestTick + 1 }))
      },
      onRoomUpdated: (room) => {
        detailsRequest.current?.abort()
        setState((prev) => ({ ...prev, room: prev.room ? { ...prev.room, ...room } : null }))
      },
      onRoomClosed: () => setState((prev) => ({ ...prev, gone: true, connection: 'idle' })),
      onResyncRequired: () => setReloadToken((n) => n + 1),
      onConnectionChange: (connection) => {
        if (connection === 'reconnecting') {
          // Debounce: only show the banner if the outage sticks. Sub-second SSE blips
          // (e.g. app switch) recover silently without flashing the header.
          const token = window.setTimeout(() => {
            setState((prev) => (prev.connection === 'connecting' ? { ...prev, connection: 'reconnecting' } : prev))
          }, 600)
          reconnectTimer.current = token
          setState((prev) => {
            if (prev.connection === 'reconnecting') return prev
            if (prev.connection === 'open' || prev.connection === 'mock') return prev
            return { ...prev, connection: 'connecting' }
          })
          return
        }
        if (reconnectTimer.current) {
          window.clearTimeout(reconnectTimer.current)
          reconnectTimer.current = 0
        }
        setState((prev) => (prev.connection === connection ? prev : { ...prev, connection }))
      },
    })
  }, [roomId, addItems, reloadMembers])

  // Snapshot load. Re-runs on reloadToken changes (a resync or an explicit refresh).
  // Lifecycle: unmount closes the SSE stream and aborts in-flight reads, so leaving the room page
  // never keeps the room online for the home recovery entry. Visibility/focus changes re-read the
  // session + snapshot via the caller's convergence (RoomPage), never resurrecting a left room.
  useEffect(() => {
    const controller = new AbortController()
    snapshotGeneration.current += 1
    detailsRequest.current?.abort()
    streamRef.current?.close()
    loadSnapshot(roomId, controller.signal, oldestLoaded.current)
      .then((snapshot) => {
        if (controller.signal.aborted) return
        deleted.current.clear()
        seen.current = new Set(snapshot.items.map((i) => i.id))
        setState((prev) => ({
          ...prev,
          room: snapshot.room,
          members: snapshot.members,
          items: sortItems(snapshot.items),
          nextCursor: snapshot.nextCursor,
          loading: false,
          error: null,
          gone: false,
        }))
        subscribeFrom(snapshot.room.eventCursor)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        const message = error instanceof Error ? error.message : '加载失败'
        const code = isApiError(error) ? error.code : 'UNKNOWN'
        const gone = isApiError(error) && (error.status === 404 || error.status === 403 || error.status === 401)
        setState((prev) => ({ ...prev, loading: false, error: { code, message }, gone }))
      })
    return () => controller.abort()
  }, [roomId, reloadToken, subscribeFrom])

  useEffect(() => () => {
    streamRef.current?.close()
    streamRef.current = null
    membersRequest.current?.abort()
    detailsRequest.current?.abort()
    if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
  }, [])

  const refresh = useCallback(() => setReloadToken((n) => n + 1), [])

  const refreshDetails = useCallback(async () => {
    detailsRequest.current?.abort()
    const controller = new AbortController()
    detailsRequest.current = controller
    try {
      const room = await fetchRoomSnapshot(roomId, controller.signal)
      if (controller.signal.aborted) return
      setState(prev => ({ ...prev, room, error: null }))
      reloadMembers()
    } catch (error) {
      if (controller.signal.aborted) return
      setState(prev => ({ ...prev, error: { code: isApiError(error) ? error.code : 'UNKNOWN', message: '房间信息更新失败' } }))
    }
  }, [roomId, reloadMembers])

  const loadOlder = useCallback(async () => {
    if (!state.nextCursor) return
    const generation = snapshotGeneration.current
    let page
    try {
      page = await fetchItems(roomId, state.nextCursor)
    } catch (error) {
      if (isApiError(error) && error.code === 'CURSOR_INVALID') {
        setReloadToken((n) => n + 1)
        return
      }
      throw error
    }
    if (generation !== snapshotGeneration.current) return
    const older = page.items.filter((i) => !seen.current.has(i.id) && !deleted.current.has(i.id))
    older.reverse()
    older.forEach((i) => seen.current.add(i.id))
    setState((prev) => ({ ...prev, items: sortItems([...older, ...prev.items]), nextCursor: page.nextCursor }))
  }, [roomId, state.nextCursor])

  const addItem = useCallback((item: RoomItem) => addItems([item]), [addItems])

  const removeItem = useCallback((itemId: string) => {
    deleted.current.add(itemId)
    seen.current.delete(itemId)
    setState((prev) => ({ ...prev, items: prev.items.filter((i) => i.id !== itemId) }))
  }, [])

  return { ...state, refresh, refreshDetails, loadOlder, addItem, removeItem }
}

function sortItems(items: RoomItem[]) {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
