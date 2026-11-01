// Live room events over SSE (protocol.md §SSE). EventSource carries the session cookie and resends
// Last-Event-ID automatically when the browser reconnects. The server ends each stream after ~120s;
// EventSource then reconnects on its own. Events are de-duplicated by eventId by the consumer.
import { parseMember, parseRoom, parseRoomItem } from '@/shared/api/schema'
import { env } from '@/shared/config/env'
import type { Room, RoomItem } from '@/shared/types/domain'

export type RoomEventHandlers = {
  onItemCreated: (item: RoomItem) => void
  onItemDeleted: (itemId: string) => void
  onMembersChanged: () => void
  onRoomUpdated: (room: Room) => void
  onRoomClosed: () => void
  // The server could not resume from the cursor: take a fresh snapshot, then resubscribe.
  onResyncRequired: () => void
  onConnectionChange: (state: 'connecting' | 'open' | 'reconnecting') => void
}

export type RoomEventStream = { close: () => void }

// Subscribes from a snapshot cursor. Returns a handle that closes the stream; callers must close it
// on unmount or room change so no stale stream keeps delivering events.
export function subscribeRoomEvents(roomId: string, cursor: string, handlers: RoomEventHandlers): RoomEventStream {
  const url = `${env.apiBaseUrl}/rooms/${roomId}/events?cursor=${encodeURIComponent(cursor)}`
  const source = new EventSource(url, { withCredentials: true })
  let closed = false
  let lastPresenceRefresh = 0

  handlers.onConnectionChange('connecting')
  source.onopen = () => handlers.onConnectionChange('open')
  source.onerror = () => {
    if (!closed) {
      handlers.onConnectionChange('reconnecting')
      handlers.onMembersChanged()
    }
  }

  source.addEventListener('heartbeat', () => {
    handlers.onConnectionChange('open')
    if (Date.now() - lastPresenceRefresh >= 30_000) {
      lastPresenceRefresh = Date.now()
      handlers.onMembersChanged()
    }
  })

  source.addEventListener('resync.required', () => {
    closed = true
    source.close()
    handlers.onResyncRequired()
  })

  const seenEvents = new Set<string>()
  const resync = () => {
    if (closed) return
    closed = true
    source.close()
    handlers.onResyncRequired()
  }
  const listen = (type: string, consume: (data: unknown) => void) => {
    source.addEventListener(type, (event) => {
      if (closed) return
      const envelope = parseEnvelope(event)
      if (!envelope || envelope.roomId !== roomId || envelope.type !== type) { resync(); return }
      if (seenEvents.has(envelope.eventId)) return
      try {
        consume(envelope.data)
        seenEvents.add(envelope.eventId)
        // Bound memory across long-running rooms and automatic EventSource reconnects.
        if (seenEvents.size > 512) seenEvents.delete(seenEvents.values().next().value!)
      } catch {
        resync()
      }
    })
  }
  listen('item.created', (data) => {
    const item = parseRoomItem(data)
    if (item.roomId !== roomId) throw new Error('Room mismatch')
    handlers.onItemCreated(item)
  })
  listen('item.deleted', (data) => handlers.onItemDeleted(parseDeletedId(data)))
  const membersChanged = (data: unknown) => {
    parseMember(data)
    handlers.onMembersChanged()
  }
  listen('member.joined', membersChanged)
  listen('member.updated', membersChanged)
  listen('member.left', (data) => { parseDeletedId(data); handlers.onMembersChanged() })
  listen('room.updated', (data) => {
    const room = parseRoom(data)
    if (room.id !== roomId) throw new Error('Room mismatch')
    handlers.onRoomUpdated(room)
  })
  listen('room.closed', (data) => {
    if (parseDeletedId(data) !== roomId) throw new Error('Room mismatch')
    closed = true
    source.close()
    handlers.onRoomClosed()
  })

  return {
    close: () => {
      closed = true
      source.close()
    },
  }
}

type Envelope = { eventId: string; type: string; roomId: string; data: unknown }

function parseEnvelope(event: Event): Envelope | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return null
  try {
    const value: unknown = JSON.parse(event.data)
    if (!isRecord(value) || typeof value.eventId !== 'string' || !value.eventId || typeof value.type !== 'string' || typeof value.roomId !== 'string') return null
    return { eventId: value.eventId, type: value.type, roomId: value.roomId, data: value.data }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}


function parseDeletedId(data: unknown): string {
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id) throw new Error('Invalid deleted resource')
  return data.id
}
