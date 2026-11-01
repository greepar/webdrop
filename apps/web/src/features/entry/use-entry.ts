import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAbortError, isApiError } from '@/shared/api/errors'
import { createRoom, getJoinRequest, joinRoom, withdrawJoinRequest } from '@/features/room/api'
import { newIdempotencyKey } from '@/shared/api/session-token'
import { useSession } from '@/features/session/use-session'
import { useCapabilities } from '@/features/entry/use-capabilities'
import { usePow, type PowStatus } from '@/shared/pow/use-pow'
import type { JoinRequest } from '@/shared/types/domain'

type Notice = { tone: 'error' | 'info'; text: string } | null
type Kind = 'create' | 'random' | 'join'

// An application waiting for owner approval. The applicant is not a member yet: no snapshot, members,
// items or SSE until the status endpoint reports approved.
export type PendingApplication = { roomId: string; request: JoinRequest }

const POLL_MS = 3_000

export type RecoverableRoom = { roomId: string; code: string; role: 'owner' | 'member'; locked: boolean; hasPassword: boolean; approvalRequired: boolean }

export function useEntry() {
  const navigate = useNavigate()
  const pow = usePow()
  // Bootstraps the anonymous device session (POST /sessions) before the first protected request.
  const session = useSession()
  const sessionState = session.state
  const { capabilities, error: capabilityError, retry: retryCapabilities } = useCapabilities()
  const [code, setCodeState] = useState('')
  const [busy, setBusy] = useState<Kind | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  // Offer "create room" only after the typed code could not be joined. Creation enters
  // directly with defaults; password and approval are configured inside the room.
  const [canCreate, setCanCreate] = useState(false)
  // Password is requested only after the server answered ROOM_PASSWORD_INVALID. It lives in component
  // state for the duration of the attempt: never in the URL, storage or logs.
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [pending, setPending] = useState<PendingApplication | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const pendingRef = useRef(false)
  const operationRef = useRef<AbortController | null>(null)
  useEffect(() => () => operationRef.current?.abort(), [])

  const length = capabilities?.roomCodeLength ?? 4

  const setCode = useCallback((value: string) => {
    setNotice(null)
    setCanCreate(false)
    setPasswordRequired(false)
    setCodeState(value)
  }, [])

  const submit = useCallback(async (kind: Kind, options: { auto?: boolean; password?: string } = {}) => {
    if (pendingRef.current || pow.status.phase === 'cooldown') return
    if (sessionState.phase !== 'ready' && sessionState.phase !== 'ready-stale') {
      setNotice({ tone: 'error', text: sessionState.phase === 'loading' ? '正在准备连接，请稍候' : '无法建立连接，请使用下方重试按钮' })
      return
    }
    if (!capabilities) {
      setNotice({ tone: 'error', text: '房间设置尚未加载，请稍后重试' })
      return
    }
    if (kind !== 'random' && !new RegExp(`^\\d{${length}}$`).test(code)) {
      setNotice({ tone: 'error', text: `请输入 ${length} 位房间号` })
      return
    }
    // The password comes from the form on the same click, never from a state read that may be stale.
    const password = options.password ?? ''
    if (kind === 'join' && passwordRequired && password.length === 0) {
      setNotice({ tone: 'error', text: '请输入房间密码' })
      return
    }
    const operation = new AbortController()
    operationRef.current = operation
    pendingRef.current = true
    setBusy(kind)
    setNotice(null)
    const idempotencyKey = newIdempotencyKey()
    try {
      const action = kind === 'join' ? 'room.join' : 'room.create'
      const proof = await pow.obtainProof(kind === 'random' ? { action, idempotencyKey } : { action, code, idempotencyKey })
      if (!proof || operation.signal.aborted) return
      if (kind === 'join') {
        const result = await joinRoom(proof, code, idempotencyKey, passwordRequired ? password : undefined, operation.signal)
        if (operation.signal.aborted) return
        if ('request' in result) {
          setPending({ roomId: result.roomId, request: result.request })
          return
        }
        navigate(`/rooms/${result.room.id}`)
        return
      }
      const membership = await createRoom(
        proof,
        kind === 'create' ? code : null,
        idempotencyKey,
        {},
        operation.signal,
      )
      if (operation.signal.aborted) return
      setCanCreate(false)
      navigate(`/rooms/${membership.room.id}`)
    } catch (error) {
      if (operation.signal.aborted || isAbortError(error)) return
      if (isApiError(error) && error.code === 'POW_INVALID') {
        setNotice({ tone: 'error', text: '验证已失效，请重试' })
      } else if (isApiError(error) && error.code === 'ROOM_PASSWORD_INVALID') {
        // The contract consumes the challenge on a wrong password, so the next attempt needs a new
        // proof and a new idempotency key. Ask for the password instead of showing a dead end.
        setPasswordRequired(true)
        setNotice({ tone: 'error', text: passwordRequired ? '密码不正确，请重试' : '这个房间需要密码' })
      } else if (isApiError(error) && error.code === 'CODE_TAKEN') {
        setNotice({ tone: 'error', text: '这个房间号已被占用，请换一个' })
      } else if (isApiError(error) && error.code === 'ROOM_UNAVAILABLE') {
        if (options.auto) {
          // No room (or not joinable) with this code: offer creation quietly instead of an error.
          // RoomCodeInput already reserves the hint slot, so this does not shift layout.
          setCanCreate(true)
          setNotice(null)
        } else {
          setNotice({ tone: 'error', text: '房间不存在或暂不可加入' })
        }
      } else if (isApiError(error) && error.code === 'ROOM_FULL') {
        setNotice({ tone: 'error', text: '房间已满' })
      } else if (isApiError(error) && error.code === 'JOIN_REQUEST_LIMIT') {
        setNotice({ tone: 'error', text: '这个房间的申请已满，请稍后再试' })
      } else if (isApiError(error) && error.code === 'RATE_LIMITED') {
        setNotice({ tone: 'error', text: error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试' })
      } else {
        setNotice({ tone: 'error', text: '操作未完成，请重试' })
      }
    } finally {
      if (operationRef.current === operation) {
        pendingRef.current = false
        setBusy(null)
      }
    }
  }, [code, length, navigate, pow, sessionState.phase, capabilities, passwordRequired])

  // Completing all boxes joins immediately. The ref stops a failed attempt from retrying on every
  // render; editing a digit changes the code and arms the next attempt.
  const attemptedRef = useRef<string | null>(null)
  useEffect(() => {
    if (code.length !== length || pending) {
      attemptedRef.current = null
      return
    }
    if (busy || pendingRef.current || attemptedRef.current === code) return
    attemptedRef.current = code
    void submit('join', { auto: true })
  }, [busy, code, length, submit, pending])

  // Poll the application every 3s while the page is visible. Approved opens the room; rejected,
  // expired and withdrawn end the wait. A 404 means the request is gone (room closed, record
  // cleaned up, or withdrawn elsewhere).
  useEffect(() => {
    if (!pending) return
    let stopped = false
    let timer = 0
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const request = await getJoinRequest(pending.roomId, pending.request.id)
        if (stopped) return
        if (request.status === 'approved') {
          setPending(null)
          navigate(`/rooms/${pending.roomId}`)
          return
        }
        if (request.status === 'rejected' || request.status === 'expired' || request.status === 'withdrawn') {
          setPending(null)
          setNotice({
            tone: 'error',
            text: request.status === 'rejected' ? '房主没有同意这次申请' : request.status === 'withdrawn' ? '申请已取消' : '申请已过期，请重新加入',
          })
          setCodeState('')
          return
        }
        // Still pending: nothing changed, so do not rewrite state (which would restart this effect).
      } catch (error) {
        if (stopped) return
        if (isApiError(error) && error.status === 404) {
          setPending(null)
          setNotice({ tone: 'error', text: '申请已失效，请重新加入' })
          setCodeState('')
        }
      }
    }
    void poll()
    timer = window.setInterval(() => void poll(), POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pending, navigate])

  const busyNow = busy !== null || pow.status.phase === 'fetching' || pow.status.phase === 'solving'
  const currentSession = sessionState.phase === 'ready' || sessionState.phase === 'ready-stale' ? sessionState.session : null
  // Recoverable rooms come only from the server session. The list is a shortcut: opening one still
  // revalidates the snapshot and membership inside the room page.
  const recoverable: RecoverableRoom[] = (currentSession?.memberships ?? []).map((membership) => ({
    roomId: membership.room.id,
    code: membership.room.code,
    role: membership.membership.role,
    locked: membership.room.joinPolicy === 'locked',
    hasPassword: membership.room.hasPassword,
    approvalRequired: membership.room.approvalRequired,
  }))

  // Withdraws the applicant's own pending request server-side, then drops the waiting UI.
  // A 404 means the request is already gone (decided/expired/closed): same outcome, no error.
  const cancelPending = useCallback(async () => {
    const current = pending
    if (!current || cancelRef.current) return
    cancelRef.current = true
    setCancelling(true)
    setCancelError(null)
    try {
      await withdrawJoinRequest(current.roomId, current.request.id)
      setPending(null)
      setCodeState('')
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        setPending(null)
        setCodeState('')
        return
      }
      setCancelError(isApiError(error) && error.status === 429
        ? error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试'
        : '取消未成功，请重试')
    } finally {
      cancelRef.current = false
      setCancelling(false)
    }
  }, [pending])

  return {
    code,
    setCode,
    length,
    passwordRequired,
    pending,
    cancelling,
    cancelError,
    cancelPending: () => void cancelPending(),
    deviceName: currentSession?.displayName ?? null,
    renamingDevice: false,
    renameDevice: session.rename,
    sessionError: sessionState.phase === 'error' ? sessionState.message : sessionState.phase === 'ready-stale' ? sessionState.message : null,
    sessionStale: sessionState.phase === 'ready-stale',
    retrySession: session.refresh,
    capabilityError,
    retryCapabilities,
    busyNow,
    busy,
    notice,
    powStatus: pow.status,
    cancelPow: () => {
      operationRef.current?.abort()
      operationRef.current = null
      pendingRef.current = false
      setBusy(null)
      pow.cancel()
    },
    canCreate,
    recoverable,
    openRecovered: (roomId: string) => navigate(`/rooms/${roomId}`),
    createRoom: () => submit('create'),
    randomRoom: () => submit('random'),
    joinRoom: (password?: string) => submit('join', { password }),
  }
}

export function describePow(status: PowStatus): string | null {
  switch (status.phase) {
    case 'fetching':
      return '正在准备验证…'
    case 'solving':
      return '正在验证，请稍候'
    case 'solved':
      return '计算完成，正在提交验证'
    case 'failed':
      return status.message
    case 'cooldown':
      return `请求过于频繁，${status.retryAfter} 秒后再试`
    default:
      return null
  }
}
