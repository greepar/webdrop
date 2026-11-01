import type {
  Asset,
  Capabilities,
  Challenge,
  Member,
  Membership,
  Room,
  RoomItem,
  RoomSnapshot,
  Session,
  SharedAsset,
  ShareLink,
} from '@/shared/types/domain'
import {
  asArray,
  asNullableString,
  asNumber,
  asObject,
  asOneOf,
  asString,
} from '@/shared/api/validate'

const roles = ['owner', 'member'] as const
const assetStatuses = ['pending', 'uploading', 'uploaded', 'ready', 'failed', 'cancelled', 'expired'] as const

export function parseCapabilities(value: unknown): Capabilities {
  const o = asObject(value, 'capabilities')
  return {
    roomCodeLength: asNumber(o.roomCodeLength, 'capabilities.roomCodeLength'),
    allowedRoomCodeLengths: asArray(o.allowedRoomCodeLengths, 'capabilities.allowedRoomCodeLengths', (v) => asNumber(v, 'length')),
    maxDevices: asNumber(o.maxDevices, 'capabilities.maxDevices'),
    maxFileBytes: asNumber(o.maxFileBytes, 'capabilities.maxFileBytes'),
    roomQuotaBytes: asNumber(o.roomQuotaBytes, 'capabilities.roomQuotaBytes'),
    roomIdleSeconds: asNumber(o.roomIdleSeconds, 'capabilities.roomIdleSeconds'),
    linkDefaultSeconds: asNumber(o.linkDefaultSeconds, 'capabilities.linkDefaultSeconds'),
    heartbeatSeconds: asNumber(o.heartbeatSeconds, 'capabilities.heartbeatSeconds'),
  }
}

export function parseRoom(value: unknown): Room {
  const o = asObject(value, 'room')
  return {
    id: asString(o.id, 'room.id'),
    code: asString(o.code, 'room.code'),
    ownerMemberId: asString(o.ownerMemberId, 'room.ownerMemberId'),
    createdAt: asString(o.createdAt, 'room.createdAt'),
    joinPolicy: asOneOf(o.joinPolicy, ['open', 'locked'], 'room.joinPolicy'),
    expiresAt: asNullableString(o.expiresAt, 'room.expiresAt'),
  }
}

export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  const o = asObject(value, 'roomSnapshot')
  return { ...parseRoom(o), eventCursor: asString(o.eventCursor, 'roomSnapshot.eventCursor') }
}

export function parseMember(value: unknown): Member {
  const o = asObject(value, 'member')
  return {
    id: asString(o.id, 'member.id'),
    deviceId: asString(o.deviceId, 'member.deviceId'),
    displayName: asString(o.displayName, 'member.displayName'),
    role: asOneOf(o.role, roles, 'member.role'),
    joinedAt: asString(o.joinedAt, 'member.joinedAt'),
    presence: asOneOf(o.presence, ['online', 'offline'], 'member.presence'),
  }
}

export function parseMembership(value: unknown): Membership {
  const o = asObject(value, 'membership')
  return { room: parseRoom(o.room), membership: parseMember(o.membership) }
}

export function parseSession(value: unknown): Session {
  const o = asObject(value, 'session')
  return {
    deviceId: asString(o.deviceId, 'session.deviceId'),
    displayName: asString(o.displayName, 'session.displayName'),
    csrfToken: asString(o.csrfToken, 'session.csrfToken'),
    memberships: asArray(o.memberships, 'session.memberships', parseMembership),
  }
}

export function parseAsset(value: unknown): Asset {
  const o = asObject(value, 'asset')
  return {
    id: asString(o.id, 'asset.id'),
    filename: asString(o.filename, 'asset.filename'),
    sizeBytes: asNumber(o.sizeBytes, 'asset.sizeBytes'),
    contentType: asString(o.contentType, 'asset.contentType'),
    sha256: asNullableString(o.sha256, 'asset.sha256'),
    status: asOneOf(o.status, assetStatuses, 'asset.status'),
    createdAt: asString(o.createdAt, 'asset.createdAt'),
  }
}

export function parseRoomItem(value: unknown): RoomItem {
  const o = asObject(value, 'item')
  const kind = asOneOf(o.kind, ['text', 'asset'] as const, 'item.kind')
  return {
    id: asString(o.id, 'item.id'),
    roomId: asString(o.roomId, 'item.roomId'),
    senderMemberId: asString(o.senderMemberId, 'item.senderMemberId'),
    createdAt: asString(o.createdAt, 'item.createdAt'),
    kind,
    text: asNullableString(o.text, 'item.text'),
    asset: o.asset === null ? null : parseAsset(o.asset),
  }
}

export function parseChallenge(value: unknown): Challenge {
  const o = asObject(value, 'challenge')
  const difficulty = asNumber(o.difficulty, 'challenge.difficulty')
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) throw new Error('Unexpected response: challenge.difficulty')
  if (o.version !== 1) throw new Error('Unexpected response: challenge.version')
  if (o.algorithm !== 'sha256-leading-zero-bits') throw new Error('Unexpected response: challenge.algorithm')
  return {
    challengeId: asString(o.challengeId, 'challenge.challengeId'),
    version: 1,
    algorithm: 'sha256-leading-zero-bits',
    difficulty,
    input: asString(o.input, 'challenge.input'),
    expiresAt: asString(o.expiresAt, 'challenge.expiresAt'),
  }
}

export function parseShareLink(value: unknown): ShareLink {
  const o = asObject(value, 'shareLink')
  return {
    id: asString(o.id, 'shareLink.id'),
    assetId: asString(o.assetId, 'shareLink.assetId'),
    slug: asString(o.slug, 'shareLink.slug'),
    expiresAt: asString(o.expiresAt, 'shareLink.expiresAt'),
    revokedAt: asNullableString(o.revokedAt, 'shareLink.revokedAt'),
    shareUrl: asString(o.shareUrl, 'shareLink.shareUrl'),
    contentUrl: asString(o.contentUrl, 'shareLink.contentUrl'),
  }
}

export function parseSharedAsset(value: unknown): SharedAsset {
  const o = asObject(value, 'sharedAsset')
  return {
    asset: parseAsset(o.asset),
    expiresAt: asString(o.expiresAt, 'sharedAsset.expiresAt'),
    contentUrl: asString(o.contentUrl, 'sharedAsset.contentUrl'),
  }
}
