// Mirrors packages/contracts/openapi.yaml (v0.3.0). Field names and enums follow the schema exactly.
// Opaque IDs are strings. Room codes keep leading zeros. Nonces are decimal strings, never numbers.

export type MemberRole = 'owner' | 'member'

export type Capabilities = {
  roomCodeLength: number
  allowedRoomCodeLengths: number[]
  maxDevices: number
  maxFileBytes: number
  roomQuotaBytes: number
  roomIdleSeconds: number
  linkDefaultSeconds: number
  heartbeatSeconds: number
}

export type Member = {
  id: string
  deviceId: string
  displayName: string
  role: MemberRole
  joinedAt: string
  presence: 'online' | 'offline'
}

export type Room = {
  id: string
  code: string
  ownerMemberId: string
  createdAt: string
  joinPolicy: 'open' | 'locked'
  expiresAt: string | null
  // Display-only: whether new members must supply a password. Never an authorization signal.
  hasPassword: boolean
  approvalRequired: boolean
}

export type RoomSnapshot = Room & { eventCursor: string }

export type Membership = { room: Room; membership: Member }

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export type JoinRequest = {
  id: string
  displayName: string
  createdAt: string
  expiresAt: string
  status: JoinRequestStatus
}

// 202 from POST /rooms/join: a pending application, not a membership. The applicant cannot read the
// room until it is approved.
export type JoinRequestCreated = { roomId: string; request: JoinRequest }

export type Session = {
  deviceId: string
  displayName: string
  csrfToken: string
  memberships: Membership[]
}

export type AssetStatus = 'pending' | 'uploading' | 'uploaded' | 'ready' | 'failed' | 'cancelled' | 'expired'

export type Asset = {
  id: string
  filename: string
  sizeBytes: number
  contentType: string
  sha256: string | null
  status: AssetStatus
  createdAt: string
}

export type RoomItem = {
  id: string
  roomId: string
  senderMemberId: string
  createdAt: string
  kind: 'text' | 'asset'
  text: string | null
  asset: Asset | null
}

export type ShareLink = {
  id: string
  assetId: string
  slug: string
  expiresAt: string
  revokedAt: string | null
  shareUrl: string
  contentUrl: string
}

export type SharedAsset = {
  asset: Asset
  expiresAt: string
  contentUrl: string
}

export type Challenge = {
  challengeId: string
  version: 1
  algorithm: 'sha256-leading-zero-bits'
  difficulty: number
  input: string
  expiresAt: string
}

export type Proof = { challengeId: string; nonce: string }

export type RoomEvent = {
  eventId: string
  type: 'member.joined' | 'member.left' | 'member.updated' | 'item.created' | 'item.deleted' | 'upload.updated' | 'room.updated' | 'room.closed'
  roomId: string
  occurredAt: string
  data: unknown
}

// Narrows a room item to a file message. The contract models kind and payload as nullable fields,
// so a message is a file only when `asset` is present.
export type AssetItem = RoomItem & { asset: Asset }

export function isAssetItem(item: RoomItem): item is AssetItem {
  return item.asset !== null
}
