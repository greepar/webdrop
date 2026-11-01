import { request, uploadBytes } from '@/shared/api/client'
import {
  parseAsset,
  parseCapabilities,
  parseMember,
  parseMembership,
  parseRoom,
  parseRoomItem,
  parseRoomSnapshot,
  parseJoinRequest,
  parseJoinRequestCreated,
  parseSession,
  parseShareLink,
  parseSharedAsset,
} from '@/shared/api/schema'
import { setCsrfToken } from '@/shared/api/session-token'
import { asArray, asObject, asString, unwrapData, unwrapList } from '@/shared/api/validate'
import type { Capabilities, JoinRequest, JoinRequestCreated, Member, Membership, Proof, Room, RoomItem, RoomSnapshot, Session, ShareLink, SharedAsset } from '@/shared/types/domain'

export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  return parseCapabilities(unwrapData(await request('/capabilities', { signal }), 'capabilities'))
}

// Creates a session (201) or restores the existing cookie session (200). SessionCreated has no
// memberships; the CSRF token is kept in memory for subsequent writes.
export async function createOrRestoreSession(displayName: string | undefined, signal?: AbortSignal) {
  const payload = await request('/sessions', { method: 'POST', body: displayName ? { displayName } : {}, signal })
  const data = asObject(unwrapData(payload, 'session'), 'session')
  const created = {
    deviceId: asString(data.deviceId, 'session.deviceId'),
    displayName: asString(data.displayName, 'session.displayName'),
    csrfToken: asString(data.csrfToken, 'session.csrfToken'),
  }
  setCsrfToken(created.csrfToken)
  return created
}

export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const session = parseSession(unwrapData(await request('/session', { signal }), 'session'))
  setCsrfToken(session.csrfToken)
  return session
}

export type CreateRoomOptions = { password?: string; approvalRequired?: boolean }

export async function createRoom(proof: Proof, code: string | null, idempotencyKey: string, options: CreateRoomOptions = {}, signal?: AbortSignal): Promise<Membership> {
  const body: Record<string, unknown> = { proof }
  if (code !== null) body.code = code
  if (options.password !== undefined) body.password = options.password
  if (options.approvalRequired !== undefined) body.approvalRequired = options.approvalRequired
  const payload = await request('/rooms', { method: 'POST', body, idempotencyKey, signal })
  return parseMembership(unwrapData(payload, 'membership'))
}

// 201/200 returns a membership; 202 means an approval request is pending and the applicant has no
// access to the room yet.
export async function joinRoom(proof: Proof, code: string, idempotencyKey: string, password?: string, signal?: AbortSignal): Promise<Membership | JoinRequestCreated> {
  const body: Record<string, unknown> = { code, proof }
  if (password !== undefined) body.password = password
  const payload = await request('/rooms/join', { method: 'POST', body, idempotencyKey, signal })
  const data = asObject(unwrapData(payload, 'join'), 'join')
  return 'request' in data ? parseJoinRequestCreated(data) : parseMembership(data)
}

export async function fetchRoomSnapshot(roomId: string, signal?: AbortSignal): Promise<RoomSnapshot> {
  return parseRoomSnapshot(unwrapData(await request(`/rooms/${roomId}`, { signal }), 'roomSnapshot'))
}

export async function fetchMembers(roomId: string, signal?: AbortSignal): Promise<Member[]> {
  return fetchAllPages(`/rooms/${roomId}/members`, parseMember, signal)
}

export async function fetchItems(roomId: string, cursor: string | null, signal?: AbortSignal) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const page = unwrapList(await request(`/rooms/${roomId}/items${query}`, { signal }), 'items')
  return { items: asArray(page.data, 'items', parseRoomItem), nextCursor: page.nextCursor }
}

export async function postText(roomId: string, text: string, idempotencyKey: string, signal?: AbortSignal): Promise<RoomItem> {
  return parseRoomItem(unwrapData(await request(`/rooms/${roomId}/items`, { method: 'POST', body: { text }, idempotencyKey, signal }), 'item'))
}

export async function deleteItem(roomId: string, itemId: string): Promise<void> {
  await request(`/rooms/${roomId}/items/${itemId}`, { method: 'DELETE' })
}

// `me` is the contract's sentinel for leaving the room; the owner cannot leave (close the room instead).
export async function leaveRoom(roomId: string): Promise<void> {
  await request(`/rooms/${roomId}/members/me`, { method: 'DELETE' })
}

export async function removeMember(roomId: string, memberId: string): Promise<void> {
  await request(`/rooms/${roomId}/members/${memberId}`, { method: 'DELETE' })
}

export async function closeRoom(roomId: string): Promise<void> {
  await request(`/rooms/${roomId}`, { method: 'DELETE' })
}

export type RoomSettingsPatch = {
  joinPolicy?: 'open' | 'locked'
  // undefined keeps the current password, null clears it.
  password?: string | null
  approvalRequired?: boolean
}

// Owner-only. Fields are applied atomically; at least one must be present.
export async function updateRoomSettings(roomId: string, patch: RoomSettingsPatch): Promise<Room> {
  return parseRoom(unwrapData(await request(`/rooms/${roomId}`, { method: 'PATCH', body: patch }), 'room'))
}

export async function setJoinPolicy(roomId: string, joinPolicy: 'open' | 'locked'): Promise<Room> {
  return updateRoomSettings(roomId, { joinPolicy })
}

export async function listJoinRequests(roomId: string, signal?: AbortSignal): Promise<JoinRequest[]> {
  return asArray(unwrapData(await request(`/rooms/${roomId}/join-requests`, { signal }), 'joinRequests'), 'joinRequests', parseJoinRequest)
}

export async function getJoinRequest(roomId: string, requestId: string, signal?: AbortSignal): Promise<JoinRequest> {
  return parseJoinRequest(unwrapData(await request(`/rooms/${roomId}/join-requests/${requestId}`, { signal }), 'joinRequest'))
}

export async function decideJoinRequest(roomId: string, requestId: string, decision: 'approve' | 'reject'): Promise<JoinRequest> {
  return parseJoinRequest(unwrapData(await request(`/rooms/${roomId}/join-requests/${requestId}/${decision}`, { method: 'POST', body: {} }), 'joinRequest'))
}

export async function rotateRoomCode(roomId: string): Promise<Room> {
  return parseRoom(unwrapData(await request(`/rooms/${roomId}/code/rotate`, { method: 'POST' }), 'room'))
}

export async function createUpload(roomId: string, file: File, idempotencyKey: string) {
  const payload = await request(`/rooms/${roomId}/uploads`, {
    method: 'POST',
    body: { filename: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' },
    idempotencyKey,
  })
  const data = asObject(unwrapData(payload, 'upload'), 'upload')
  return { uploadId: asString(data.uploadId, 'upload.uploadId'), uploadUrl: asString(data.uploadUrl, 'upload.uploadUrl') }
}

export async function uploadContent(
  uploadUrl: string,
  file: File,
  options: { onProgress: (loaded: number, total: number) => void; signal: AbortSignal },
) {
  await uploadBytes(uploadUrl, file, options)
}

export async function completeUpload(uploadId: string, idempotencyKey: string, signal?: AbortSignal): Promise<RoomItem> {
  return parseRoomItem(unwrapData(await request(`/uploads/${uploadId}/complete`, { method: 'POST', idempotencyKey, signal }), 'item'))
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await request(`/uploads/${uploadId}`, { method: 'DELETE' })
}

export async function createLink(assetId: string, idempotencyKey: string): Promise<ShareLink> {
  return parseShareLink(unwrapData(await request(`/assets/${assetId}/links`, { method: 'POST', body: {}, idempotencyKey }), 'shareLink'))
}

export async function fetchRoomLinks(roomId: string, signal?: AbortSignal): Promise<ShareLink[]> {
  return fetchAllPages(`/rooms/${roomId}/links`, parseShareLink, signal)
}

export async function revokeLink(linkId: string): Promise<void> {
  await request(`/links/${linkId}`, { method: 'DELETE' })
}

export async function fetchSharedAsset(slug: string, signal?: AbortSignal): Promise<SharedAsset> {
  return parseSharedAsset(unwrapData(await request(`/shares/${slug}`, { signal }), 'sharedAsset'))
}

export async function fetchUploadStatus(uploadId: string, signal?: AbortSignal) {
  const data = asObject(unwrapData(await request(`/uploads/${uploadId}`, { signal }), 'upload'), 'upload')
  return parseAsset(data)
}

async function fetchAllPages<T extends { id: string }>(path: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T[]> {
  const rows = new Map<string, T>()
  const visited = new Set<string>()
  let cursor: string | null = null
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const page = unwrapList(await request(`${path}${query}`, { signal }), path)
    for (const row of asArray(page.data, path, parse)) rows.set(row.id, row)
    cursor = page.nextCursor
    if (cursor !== null) {
      if (visited.has(cursor)) throw new Error('列表分页游标重复')
      visited.add(cursor)
    }
  } while (cursor !== null)
  return [...rows.values()]
}
