import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAbortError, isApiError } from '@/shared/api/errors'
import { createRoom, joinRoom } from '@/features/room/api'
import { newIdempotencyKey } from '@/shared/api/session-token'
import { useSession } from '@/features/session/use-session'
import { useCapabilities } from '@/features/entry/use-capabilities'
import { usePow, type PowStatus } from '@/shared/pow/use-pow'

type Notice = { tone: 'error' | 'info'; text: string } | null
type Kind = 'create' | 'random' | 'join'

// Create (chosen code), create (random), and join are separate submissions. Each one requests its own
// proof and idempotency key; a proof is never reused across actions.
export function useEntry() {
  const navigate = useNavigate()
  const pow = usePow()
  // Bootstraps the anonymous device session (POST /sessions) before the first protected request.
  const session = useSession()
  const { capabilities, error: capabilityError, retry: retryCapabilities } = useCapabilities()
  const [code, setCodeState] = useState('')
  const [busy, setBusy] = useState<Kind | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const pendingRef = useRef(false)
  const operationRef = useRef<AbortController | null>(null)
  useEffect(() => () => operationRef.current?.abort(), [])

  const length = capabilities?.roomCodeLength ?? 4

  const setCode = useCallback((value: string) => {
    setNotice(null)
    setCodeState(value)
  }, [])

  const submit = useCallback(async (kind: Kind) => {
    if (pendingRef.current || pow.status.phase === 'cooldown') return
    if (session.state.phase !== 'ready') {
      setNotice({ tone: 'error', text: session.state.phase === 'loading' ? '正在准备连接，请稍候' : '无法建立连接，请使用下方重试按钮' })
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
      const membership = kind === 'join'
        ? await joinRoom(proof, code, idempotencyKey, operation.signal)
        : await createRoom(proof, kind === 'create' ? code : null, idempotencyKey, operation.signal)
      if (operation.signal.aborted) return
      navigate(`/rooms/${membership.room.id}`)
    } catch (error) {
      if (operation.signal.aborted || isAbortError(error)) return
      if (isApiError(error) && error.code === 'POW_INVALID') {
        setNotice({ tone: 'error', text: '验证已失效，请重试' })
      } else if (isApiError(error) && error.code === 'CODE_TAKEN') {
        setNotice({ tone: 'error', text: '这个房间号已被占用，请换一个' })
      } else if (isApiError(error) && error.code === 'ROOM_UNAVAILABLE') {
        setNotice({ tone: 'error', text: '房间不存在或暂不可加入' })
      } else if (isApiError(error) && error.code === 'ROOM_FULL') {
        setNotice({ tone: 'error', text: '房间已满' })
      } else if (isApiError(error) && error.code === 'RATE_LIMITED') {
        setNotice({ tone: 'error', text: '操作太频繁，请稍后再试' })
      } else {
        setNotice({ tone: 'error', text: '操作未完成，请重试' })
      }
    } finally {
      if (operationRef.current === operation) {
        pendingRef.current = false
        setBusy(null)
      }
    }
  }, [code, length, navigate, pow, session.state.phase, capabilities])

  const busyNow = busy !== null || pow.status.phase === 'fetching' || pow.status.phase === 'solving'

  return {
    code,
    setCode,
    length,
    sessionError: session.state.phase === 'error' ? session.state.message : null,
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
    createRoom: () => submit('create'),
    randomRoom: () => submit('random'),
    joinRoom: () => submit('join'),
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
