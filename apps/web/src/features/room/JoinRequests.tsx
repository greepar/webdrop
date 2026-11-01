import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, StatusLine } from '@/shared/ui/primitives'
import { decideJoinRequest, listJoinRequests } from '@/features/room/api'
import { isApiError } from '@/shared/api/errors'
import type { JoinRequest } from '@/shared/types/domain'

const POLL_MS = 3_000

// Owner-only queue. Polling is the contract's first-version mechanism: every 3s while visible, paused
// in the background, and it honours Retry-After on 429. There is no SSE event for applications.
export function JoinRequests({ roomId, onCount }: { roomId: string; onCount?: (count: number) => void }) {
  // null means "not loaded yet"; no separate loading state to keep in sync.
  const [requests, setRequests] = useState<JoinRequest[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // A ref guard, not just state: two clicks in the same tick both read the old state otherwise.
  const busyRef = useRef<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const retryUntil = useRef(0)
  const onCountRef = useRef(onCount)
  useEffect(() => { onCountRef.current = onCount }, [onCount])

  const apply = useCallback((list: JoinRequest[]) => {
    setRequests(list)
    onCountRef.current?.(list.length)
  }, [])

  // The first load and every poll go through the same async path; state is only written after an
  // awaited response, so no synchronous render happens inside the effect.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const tick = async () => {
      if (Date.now() < retryUntil.current) return
      try {
        const list = await listJoinRequests(roomId, controller.signal)
        if (!cancelled) apply(list)
      } catch (error) {
        if (cancelled) return
        if (isApiError(error) && error.status === 429) {
          retryUntil.current = Date.now() + (error.retryAfter ?? 5) * 1000
        }
        setRequests((current) => current ?? [])
      }
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void tick()
    }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void tick() }
    document.addEventListener('visibilitychange', onVisible)
    void tick()
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [roomId, apply])

  const refresh = useCallback(async () => {
    try {
      apply(await listJoinRequests(roomId))
    } catch {
      // Keep the current list; the poll retries.
    }
  }, [roomId, apply])

  const decide = async (request: JoinRequest, decision: 'approve' | 'reject') => {
    if (busyRef.current) return
    busyRef.current = request.id
    setBusyId(request.id)
    setNotice(null)
    try {
      await decideJoinRequest(roomId, request.id, decision)
      setRequests((list) => (list ?? []).filter((r) => r.id !== request.id))
      onCountRef.current?.(Math.max(0, (requests?.length ?? 1) - 1))
      setNotice({ tone: 'success', text: decision === 'approve' ? '已同意加入' : '已拒绝申请' })
    } catch (error) {
      if (isApiError(error) && error.code === 'ROOM_FULL') {
        setNotice({ tone: 'error', text: '房间已满，申请仍在等待' })
      } else if (isApiError(error) && error.code === 'JOIN_REQUEST_STATE') {
        setNotice({ tone: 'error', text: '这条申请已结束，正在刷新' })
        void refresh()
      } else if (isApiError(error) && error.status === 403) {
        setNotice({ tone: 'error', text: '已没有管理权限' })
      } else if (isApiError(error) && error.status === 404) {
        setNotice({ tone: 'error', text: '房间或申请已不存在' })
      } else {
        setNotice({ tone: 'error', text: '操作未完成，请重试' })
      }
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {requests === null && <p className="text-sm text-muted">正在读取申请…</p>}
      {requests?.length === 0 && <p className="text-sm text-muted">还没有待审批的申请。</p>}
      <ul className="flex flex-col divide-y divide-line">
        {(requests ?? []).map((request) => (
          <li key={request.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{request.displayName}</p>
              <p className="mt-0.5 text-xs text-muted">申请于 {formatTime(request.createdAt)}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                className="min-h-11 px-3 text-xs"
                aria-label={`拒绝 ${request.displayName} 的申请`}
                disabled={busyId !== null}
                onClick={() => decide(request, 'reject')}
              >
                拒绝
              </Button>
              <Button
                variant="secondary"
                className="min-h-11 px-3 text-xs"
                aria-label={`同意 ${request.displayName} 加入`}
                disabled={busyId !== null}
                busy={busyId === request.id}
                onClick={() => decide(request, 'approve')}
              >
                同意
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <StatusLine tone={notice?.tone === 'error' ? 'error' : 'success'}>{notice?.text}</StatusLine>
    </div>
  )
}

function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
