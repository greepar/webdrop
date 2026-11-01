// DEV MOCK. An in-memory stand-in for packages/contracts/openapi.yaml (v0.3.0) used only while the
// real API is unavailable. Responses are NOT real server results; the UI shows a "开发 mock" badge
// whenever this module is active. A mock success is never evidence that a backend feature works.
//
// Scope limits (by design, not by oversight): the mock does not enforce quotas, rate limits, real
// idempotency replay, or cursor expiry. PoW here uses the shared protocol so the worker really solves.
import type { RequestOptions } from '@/shared/api/client'
import { ApiError } from '@/shared/api/errors'
import { meetsDifficulty } from '@/shared/pow/protocol'

type MockMember = { id: string; deviceId: string; displayName: string; role: 'owner' | 'member'; joinedAt: string }
type MockAsset = { id: string; filename: string; sizeBytes: number; contentType: string; sha256: null; status: 'ready'; createdAt: string }
type MockItem = { id: string; roomId: string; senderMemberId: string; createdAt: string; kind: 'text' | 'asset'; text: string | null; asset: MockAsset | null }
type MockLink = { id: string; assetId: string; slug: string; expiresAt: string; revokedAt: string | null; creatorDeviceId: string }
type MockRoom = {
  id: string
  code: string
  ownerMemberId: string
  createdAt: string
  joinPolicy: 'open' | 'locked'
  expiresAt: null
  members: MockMember[]
  items: MockItem[]
  links: MockLink[]
  eventCursor: number
}

const CAPABILITIES = {
  roomCodeLength: 4,
  allowedRoomCodeLengths: [4],
  maxDevices: 10,
  maxFileBytes: 100_000_000,
  roomQuotaBytes: 500_000_000,
  roomIdleSeconds: 1800,
  linkDefaultSeconds: 86_400,
  heartbeatSeconds: 2,
}

const DIFFICULTY = 12
const CHALLENGE_TTL_MS = 120_000

const state = {
  deviceId: crypto.randomUUID(),
  displayName: '本机设备',
  csrfToken: crypto.randomUUID(),
  sessionCreated: false,
  rooms: new Map<string, MockRoom>(),
  byCode: new Map<string, string>(),
  challenges: new Map<string, { action: string; code: string | null; idempotencyKey: string; input: string; expiresAt: number; consumed: boolean }>(),
  uploads: new Map<string, { roomId: string; asset: MockAsset; uploadUrl: string; status: 'pending' | 'uploaded' | 'complete' }>(),
}

function now() {
  return new Date().toISOString()
}

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message)
}

function randomCode(length: number) {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return String(values[0]! % 10 ** length).padStart(length, '0')
}

function myMember(room: MockRoom) {
  return room.members.find((m) => m.deviceId === state.deviceId) ?? null
}

function requireMember(roomId: string) {
  const room = state.rooms.get(roomId)
  const membership = room ? myMember(room) : null
  if (!room || !membership) fail(404, 'ROOM_UNAVAILABLE', '房间不存在或不可加入')
  return { room, membership }
}

function roomDto(room: MockRoom) {
  return { id: room.id, code: room.code, ownerMemberId: room.ownerMemberId, createdAt: room.createdAt, joinPolicy: room.joinPolicy, expiresAt: room.expiresAt }
}

function memberDto(member: MockMember) {
  return {
    id: member.id,
    deviceId: member.deviceId,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt,
    presence: member.deviceId === state.deviceId ? 'online' : 'offline',
  }
}

function itemDto(item: MockItem) {
  return { id: item.id, roomId: item.roomId, senderMemberId: item.senderMemberId, createdAt: item.createdAt, kind: item.kind, text: item.text, asset: item.asset }
}

function membershipsForSession() {
  return [...state.rooms.values()]
    .map((room) => {
      const membership = myMember(room)
      return membership ? { room: roomDto(room), membership: memberDto(membership) } : null
    })
    .filter((x): x is { room: ReturnType<typeof roomDto>; membership: ReturnType<typeof memberDto> } => x !== null)
}

function requireWriteHeaders(options: RequestOptions) {
  if (!options.idempotencyKey) fail(400, 'VALIDATION_FAILED', '缺少 Idempotency-Key')
}

function ok<T>(data: T, status = 200) {
  return { status, body: { data } }
}

function createRoom(code: string, ownerDevice: string): MockRoom {
  if (state.byCode.has(code)) fail(409, 'CODE_TAKEN', '这个房间号已被占用，请换一个')
  const id = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const room: MockRoom = {
    id,
    code,
    ownerMemberId: memberId,
    createdAt: now(),
    joinPolicy: 'open',
    expiresAt: null,
    members: [{ id: memberId, deviceId: ownerDevice, displayName: state.displayName, role: 'owner', joinedAt: now() }],
    items: [],
    links: [],
    eventCursor: 0,
  }
  state.rooms.set(id, room)
  state.byCode.set(code, id)
  return room
}

// Verifies the proof exactly as protocol.md describes: challenge bound to this session, action and code,
// unconsumed and unexpired; then the hash is recomputed from the server-held input.
async function verifyProof(body: { code?: unknown; proof?: unknown }, action: 'room.create' | 'room.join', idempotencyKey: string) {
  const proof = body.proof as { challengeId?: unknown; nonce?: unknown } | undefined
  if (!proof || typeof proof.challengeId !== 'string' || typeof proof.nonce !== 'string') fail(400, 'POW_INVALID', '验证无效，请重新获取')
  const challenge = state.challenges.get(proof.challengeId)
  if (!challenge) fail(400, 'POW_INVALID', '验证无效，请重新获取')
  if (challenge.consumed) fail(400, 'POW_INVALID', '验证无效，请重新获取')
  if (challenge.expiresAt < Date.now()) fail(400, 'POW_INVALID', '验证无效，请重新获取')
  if (challenge.action !== action || challenge.idempotencyKey !== idempotencyKey) fail(400, 'POW_INVALID', '验证无效，请重新获取')
  if ((challenge.code ?? null) !== (typeof body.code === 'string' ? body.code : null)) fail(400, 'POW_INVALID', '验证无效，请重新获取')
  challenge.consumed = true
  if (!(await meetsDifficulty(challenge.input, proof.nonce, DIFFICULTY))) fail(400, 'POW_INVALID', '验证无效，请重新获取')
}

async function route(path: string, method: string, body: unknown, options: RequestOptions) {
  const url = new URL(path, 'http://mock.local')
  const p = url.pathname
  const b = (body ?? {}) as Record<string, unknown>

  if (method === 'GET' && p === '/capabilities') return ok(CAPABILITIES)

  if (method === 'POST' && p === '/sessions') {
    const existed = state.sessionCreated
    state.sessionCreated = true
    if (typeof b.displayName === 'string') state.displayName = b.displayName
    return { status: existed ? 200 : 201, body: { data: { deviceId: state.deviceId, displayName: state.displayName, csrfToken: state.csrfToken } } }
  }

  if (method === 'GET' && p === '/session') {
    if (!state.sessionCreated) fail(401, 'SESSION_REQUIRED', '会话不存在')
    return ok({ deviceId: state.deviceId, displayName: state.displayName, csrfToken: state.csrfToken, memberships: membershipsForSession() })
  }

  if (method === 'POST' && p === '/pow/challenges') {
    if (!state.sessionCreated) fail(401, 'SESSION_REQUIRED', '会话不存在')
    const action = b.action
    if (action !== 'room.create' && action !== 'room.join') fail(400, 'VALIDATION_FAILED', '未知操作')
    const challengeId = crypto.randomUUID()
    const input = `webdrop-pow-v1:${challengeId}:${randomCode(8)}:`
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    state.challenges.set(challengeId, {
      action,
      code: typeof b.code === 'string' ? b.code : null,
      idempotencyKey: String(b.idempotencyKey ?? ''),
      input,
      expiresAt,
      consumed: false,
    })
    return ok({ challengeId, version: 1, algorithm: 'sha256-leading-zero-bits', difficulty: DIFFICULTY, input, expiresAt: new Date(expiresAt).toISOString() }, 201)
  }

  if (method === 'POST' && p === '/rooms') {
    if (!state.sessionCreated) fail(401, 'SESSION_REQUIRED', '会话不存在')
    requireWriteHeaders(options)
    const code = typeof b.code === 'string' ? b.code : randomCode(4)
    if (!/^\d{4}$/.test(code)) fail(400, 'VALIDATION_FAILED', '房间号需要 4 位数字')
    await verifyProof(b as { code?: unknown; proof?: unknown }, 'room.create', String(options.idempotencyKey))
    const room = createRoom(code, state.deviceId)
    return ok({ room: roomDto(room), membership: memberDto(room.members[0]!) }, 201)
  }

  if (method === 'POST' && p === '/rooms/join') {
    if (!state.sessionCreated) fail(401, 'SESSION_REQUIRED', '会话不存在')
    requireWriteHeaders(options)
    const code = typeof b.code === 'string' ? b.code : ''
    await verifyProof(b as { code?: unknown; proof?: unknown }, 'room.join', String(options.idempotencyKey))
    const roomId = state.byCode.get(code)
    const room = roomId ? state.rooms.get(roomId) : undefined
    if (!room || room.joinPolicy === 'locked') fail(404, 'ROOM_UNAVAILABLE', '房间不存在或不可加入')
    let member = myMember(room)
    if (!member) {
      if (room.members.length >= CAPABILITIES.maxDevices) fail(409, 'ROOM_FULL', '房间设备数已满')
      member = { id: crypto.randomUUID(), deviceId: state.deviceId, displayName: state.displayName, role: 'member', joinedAt: now() }
      room.members.push(member)
    }
    return ok({ room: roomDto(room), membership: memberDto(member) })
  }

  const roomMatch = /^\/rooms\/([^/]+)(?:\/(.*))?$/.exec(p)
  if (roomMatch) {
    const roomId = roomMatch[1]!
    const rest = roomMatch[2] ?? ''
    const { room, membership } = requireMember(roomId)
    const isOwner = membership.role === 'owner'

    if (method === 'GET' && rest === '') return ok({ ...roomDto(room), eventCursor: String(room.eventCursor) })
    if (method === 'GET' && rest === 'members') return { status: 200, body: { data: room.members.map(memberDto), page: { nextCursor: null }, eventCursor: String(room.eventCursor) } }

    if (method === 'GET' && rest === 'items') {
      const cursor = url.searchParams.get('cursor')
      const ordered = [...room.items].reverse()
      const start = cursor ? ordered.findIndex((i) => i.id === cursor) + 1 : 0
      const slice = ordered.slice(start, start + 30)
      const next = start + 30 < ordered.length ? slice[slice.length - 1]!.id : null
      return { status: 200, body: { data: slice.map(itemDto), page: { nextCursor: next } } }
    }

    if (method === 'POST' && rest === 'items') {
      requireWriteHeaders(options)
      const text = typeof b.text === 'string' ? b.text : ''
      if (!text.trim()) fail(400, 'VALIDATION_FAILED', '内容不能为空')
      if (new TextEncoder().encode(text).length > 32_768) fail(413, 'PAYLOAD_TOO_LARGE', '文字过长')
      const item: MockItem = { id: crypto.randomUUID(), roomId, senderMemberId: membership.id, createdAt: now(), kind: 'text', text, asset: null }
      room.items.push(item)
      room.eventCursor += 1
      return ok(itemDto(item), 201)
    }

    const itemMatch = /^items\/([^/]+)$/.exec(rest)
    if (method === 'DELETE' && itemMatch) {
      const item = room.items.find((i) => i.id === itemMatch[1])
      if (!item) fail(404, 'NOT_FOUND', '内容不存在')
      if (!isOwner && item.senderMemberId !== membership.id) fail(403, 'FORBIDDEN', '没有删除权限')
      room.items = room.items.filter((i) => i !== item)
      room.eventCursor += 1
      return { status: 204, body: undefined }
    }

    if (method === 'POST' && rest === 'uploads') {
      requireWriteHeaders(options)
      const filename = typeof b.filename === 'string' ? b.filename : ''
      const sizeBytes = Number(b.sizeBytes)
      if (!filename || !Number.isInteger(sizeBytes) || sizeBytes < 1) fail(400, 'VALIDATION_FAILED', '文件信息无效')
      if (sizeBytes > CAPABILITIES.maxFileBytes) fail(413, 'FILE_TOO_LARGE', '文件超过 100 MB 上限')
      const uploadId = crypto.randomUUID()
      const asset: MockAsset = {
        id: crypto.randomUUID(),
        filename,
        sizeBytes,
        contentType: typeof b.contentType === 'string' ? b.contentType : 'application/octet-stream',
        sha256: null,
        status: 'ready',
        createdAt: now(),
      }
      const uploadUrl = `/api/v1/uploads/${uploadId}/content`
      state.uploads.set(uploadId, { roomId, asset, uploadUrl, status: 'pending' })
      return ok({ uploadId, uploadUrl, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'pending' }, 201)
    }

    if (method === 'POST' && rest === 'code/rotate') {
      if (!isOwner) fail(403, 'FORBIDDEN', '只有房主可以更换房间号')
      const next = randomCode(4)
      if (state.byCode.has(next)) fail(409, 'CODE_TAKEN', '这个房间号已被占用')
      state.byCode.delete(room.code)
      room.code = next
      state.byCode.set(next, room.id)
      return ok(roomDto(room))
    }

    if (method === 'GET' && rest === 'links') {
      return { status: 200, body: { data: room.links
        .filter((l) => !l.revokedAt && (isOwner || l.creatorDeviceId === state.deviceId))
        .map(linkDto), page: { nextCursor: null } } }
    }

    if (method === 'PATCH' && rest === '') {
      if (!isOwner) fail(403, 'FORBIDDEN', '只有房主可以修改设置')
      const joinPolicy = b.joinPolicy
      if (joinPolicy !== 'open' && joinPolicy !== 'locked') fail(400, 'VALIDATION_FAILED', '设置无效')
      room.joinPolicy = joinPolicy
      return ok(roomDto(room))
    }

    const memberMatch = /^members\/([^/]+)$/.exec(rest)
    if (method === 'DELETE' && memberMatch) {
      if (memberMatch[1] === 'me') {
        if (isOwner) fail(409, 'OWNER_MUST_CLOSE', '房主不能直接离开，请先关闭房间')
        room.members = room.members.filter((m) => m.id !== membership.id)
        return { status: 204, body: undefined }
      }
      if (!isOwner) fail(403, 'FORBIDDEN', '只有房主可以移出成员')
      if (memberMatch[1] === membership.id) fail(409, 'CONFLICT', '不能移出自己')
      room.members = room.members.filter((m) => m.id !== memberMatch[1])
      return { status: 204, body: undefined }
    }

    if (method === 'DELETE' && rest === '') {
      if (!isOwner) fail(403, 'FORBIDDEN', '只有房主可以关闭房间')
      for (const link of room.links) link.revokedAt = link.revokedAt ?? now()
      state.byCode.delete(room.code)
      state.rooms.delete(room.id)
      return { status: 204, body: undefined }
    }
  }

  const uploadContentMatch = /^\/uploads\/([^/]+)\/complete$/.exec(p)
  if (method === 'POST' && uploadContentMatch) {
    requireWriteHeaders(options)
    const upload = state.uploads.get(uploadContentMatch[1]!)
    if (!upload) fail(404, 'NOT_FOUND', '上传不存在')
    const { room, membership } = requireMember(upload.roomId)
    if (upload.status !== 'uploaded') fail(409, 'CONFLICT', '文件尚未上传完成')
    state.uploads.delete(uploadContentMatch[1]!)
    const item: MockItem = { id: crypto.randomUUID(), roomId: room.id, senderMemberId: membership.id, createdAt: now(), kind: 'asset', text: null, asset: upload.asset }
    room.items.push(item)
    room.eventCursor += 1
    return ok(itemDto(item), 201)
  }

  const uploadDeleteMatch = /^\/uploads\/([^/]+)$/.exec(p)
  if (method === 'GET' && uploadDeleteMatch) {
    const upload = state.uploads.get(uploadDeleteMatch[1]!)
    if (!upload) fail(404, 'NOT_FOUND', '上传不存在')
    requireMember(upload.roomId)
    return ok({ ...upload.asset, status: upload.status === 'complete' ? 'ready' : upload.status, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), itemId: null })
  }
  if (method === 'DELETE' && uploadDeleteMatch) {
    state.uploads.delete(uploadDeleteMatch[1]!)
    return { status: 204, body: undefined }
  }

  const assetLinkMatch = /^\/assets\/([^/]+)\/links$/.exec(p)
  if (method === 'POST' && assetLinkMatch) {
    requireWriteHeaders(options)
    const found = [...state.rooms.values()].find((room) => room.items.some((i) => i.asset?.id === assetLinkMatch[1]))
    const membership = found ? myMember(found) : null
    if (!found || !membership) fail(404, 'NOT_FOUND', '文件不存在')
    const link: MockLink = {
      id: crypto.randomUUID(),
      assetId: assetLinkMatch[1]!,
      slug: `${randomCode(3)}-${randomCode(6)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      revokedAt: null,
      creatorDeviceId: state.deviceId,
    }
    found.links.push(link)
    return ok(linkDto(link), 201)
  }

  const linkDelete = /^\/links\/([^/]+)$/.exec(p)
  if (method === 'DELETE' && linkDelete) {
    for (const room of state.rooms.values()) {
      const link = room.links.find((l) => l.id === linkDelete[1])
      if (!link) continue
      const membership = myMember(room)
      if (!membership) fail(404, 'NOT_FOUND', '链接不存在')
      if (membership.role !== 'owner' && link.creatorDeviceId !== state.deviceId) fail(403, 'FORBIDDEN', '没有撤销权限')
      link.revokedAt = now()
      return { status: 204, body: undefined }
    }
    fail(404, 'NOT_FOUND', '链接不存在')
  }

  const shareMatch = /^\/shares\/([^/]+)$/.exec(p)
  if (method === 'GET' && shareMatch) {
    for (const room of state.rooms.values()) {
      const link = room.links.find((l) => l.slug === shareMatch[1])
      if (!link) continue
      if (link.revokedAt) fail(410, 'SHARE_EXPIRED', '分享已失效')
      if (Date.parse(link.expiresAt) < Date.now()) fail(410, 'SHARE_EXPIRED', '分享已失效')
      const item = room.items.find((i) => i.asset?.id === link.assetId)
      if (!item?.asset) fail(404, 'NOT_FOUND', '分享不存在')
      return ok({ asset: item.asset, expiresAt: link.expiresAt, contentUrl: `${location.origin}/d/${link.slug}` })
    }
    fail(404, 'NOT_FOUND', '分享不存在')
  }

  throw new ApiError(404, 'NOT_FOUND', `Mock route not implemented: ${method} ${p}`)
}

function linkDto(link: MockLink) {
  return {
    id: link.id,
    assetId: link.assetId,
    slug: link.slug,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    shareUrl: `${location.origin}/s/${link.slug}`,
    contentUrl: `${location.origin}/d/${link.slug}`,
  }
}

export async function mockRequest(path: string, options: RequestOptions) {
  await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120))
  const method = options.method ?? 'GET'
  const result = await route(path, method, options.body, options)
  return result.body
}

export async function mockUploadBytes(
  url: string,
  file: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
) {
  const uploadId = /^\/api\/v1\/uploads\/([^/]+)\/content$/.exec(url)?.[1]
  const upload = uploadId ? state.uploads.get(uploadId) : undefined
  if (!upload) fail(404, 'NOT_FOUND', '上传不存在')
  const total = file.size
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 80))
    onProgress(Math.round((total * i) / steps), total)
  }
  upload.status = 'uploaded'
  upload.asset = { ...upload.asset, sizeBytes: total }
}
