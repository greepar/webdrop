import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useViewportFrame } from '@/shared/browser/use-viewport-frame'
import { useCapabilities } from '@/features/entry/use-capabilities'
import { formatBytes } from '@/features/room/format'
import { createLink } from '@/features/room/api'
import { useRoom } from '@/features/room/use-room'
import { useUploads } from '@/features/room/use-uploads'
import { MediaPreview } from '@/features/room/MediaPreview'
import { FileList } from '@/features/room/FileList'
import { MessageList } from '@/features/room/MessageList'
import { Composer } from '@/features/room/Composer'
import { RoomActions } from '@/features/room/RoomActions'
import { AssetCard } from '@/features/room/AssetCard'
import { deleteItem, fetchRoomSnapshot, fetchSession, leaveRoom, closeRoom, postText } from '@/features/room/api'
import { findMembership, notifySessionChanged, roleOf, useSession, type SessionState } from '@/features/session/use-session'
import { newIdempotencyKey } from '@/shared/api/session-token'
import { copyText } from '@/shared/clipboard'
import { isApiError } from '@/shared/api/errors'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Button, DevMockBadge, Dialog, IconButton, RoomToast, Spinner, StatusLine } from '@/shared/ui/primitives'
import { env } from '@/shared/config/env'
import type { AssetItem, RoomItem } from '@/shared/types/domain'

export function RoomPage() {
  const { roomId = '' } = useParams()
  return <RoomView key={roomId} roomId={roomId} />
}

// Keyed by room id so switching rooms remounts all room state instead of resetting it in an effect.
function RoomView({ roomId }: { roomId: string }) {
  const navigate = useNavigate()
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RoomItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deletePending = useRef(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [preview, setPreview] = useState<AssetItem | null>(null)
  const textAttempt = useRef<{ text: string; key: string } | null>(null)
  const copyAttempts = useRef(new Map<string, string>())
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Role-aware back navigation: plain return keeps the membership, member/owner actions below
  // only navigate after the server confirms 204.
  const [backOpen, setBackOpen] = useState(false)
  const [backBusy, setBackBusy] = useState<'leave' | 'close' | null>(null)
  const [backError, setBackError] = useState<string | null>(null)
  const backRef = useRef(false)

  const room = useRoom(roomId)
  const session = useSession()
  const sessionState = session.state
  const activeSession = sessionState.phase === 'ready' || sessionState.phase === 'ready-stale' ? sessionState.session : null
  const { capabilities } = useCapabilities()
  const membership = findMembership(activeSession, roomId)
  const selfMemberId = membership?.membership.id ?? ''
  const isOwner = roleOf(membership) === 'owner'
  const onUploadComplete = useCallback((item: RoomItem) => room.addItem(item), [room])
  const uploads = useUploads(roomId, onUploadComplete)
  const { abortAll } = uploads
  useEffect(() => { if (room.gone) abortAll() }, [room.gone, abortAll])

  // Multi-tab convergence: another tab may leave/close/kick/approve while this page is hidden.
  // Return path is intentionally light: only re-read room details + session (no snapshot reload,
  // no SSE teardown). A full refresh replays the connecting banner and re-lays-out the list,
  // which reads as a window jitter when switching back from another app.
  const navigatingAway = useRef(false)
  useEffect(() => {
    const markLeaving = () => { navigatingAway.current = true }
    window.addEventListener('pagehide', markLeaving)
    return () => window.removeEventListener('pagehide', markLeaving)
  }, [])
  useEffect(() => {
    const onReturn = () => {
      if (navigatingAway.current || document.visibilityState !== 'visible') return
      session.refresh()
      void room.refreshDetails()
    }
    const onFocus = () => onReturn()
    const onOnline = () => {
      navigatingAway.current = false
      session.refresh()
      void room.refreshDetails()
    }
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [room, session])

  // Connection recovered flash: only after an interruption (reconnecting -> open),
  // so the recovery is confirmed, not just silence. First entry stays quiet:
  // connecting -> open is the expected path, not news worth a toast.
  const [connectedFlash, setConnectedFlash] = useState(false)
  const hadInterruption = useRef(false)
  useEffect(() => {
    if (room.connection === 'reconnecting') {
      hadInterruption.current = true
      return
    }
    if (room.connection !== 'open' || !hadInterruption.current) return
    hadInterruption.current = false
    setConnectedFlash(true)
    const timer = window.setTimeout(() => setConnectedFlash(false), 2000)
    return () => {
      window.clearTimeout(timer)
      setConnectedFlash(false)
    }
  }, [room.connection])

  // Notices auto-dismiss after a few seconds; the toast also has a manual close button.
  // The timer resets on every new notice so a fresh error is never cut short by an old timer.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const roomErrorKey = room.error ? `${room.error.code}:${room.error.message}` : null
  const roomConnecting = room.connection === 'connecting' || room.connection === 'reconnecting'
  const roomConnectingMessage = room.connection === 'connecting' ? '正在连接实时更新…' : '连接中断，正在重连…'

  const pickFiles = (files: File[]) => {
    const accepted = files.filter((file) => file.size > 0 && (!capabilities || file.size <= capabilities.maxFileBytes))
    if (accepted.length !== files.length) {
      setNotice({ tone: 'error', text: capabilities ? `已跳过空文件或超过 ${formatBytes(capabilities.maxFileBytes)} 的文件` : '已跳过空文件' })
    }
    if (accepted.length) uploads.start(accepted)
  }

  const loadOlder = async () => {
    if (loadingOlder) return
    setLoadingOlder(true)
    try {
      await room.loadOlder()
    } catch {
      setNotice({ tone: 'error', text: '历史内容加载失败' })
    } finally {
      setLoadingOlder(false)
    }
  }



  const downloadItem = (item: AssetItem) => {
    const a = document.createElement('a')
    a.href = `/api/v1/assets/${encodeURIComponent(item.asset.id)}/content`
    a.download = item.asset.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // Reuses the share contract: create a link on demand, then copy it. No extra endpoint is added.
  // The key survives a failed/ambiguous response so a retry cannot create a second link.
  const copyItemLink = async (item: AssetItem) => {
    const key = copyAttempts.current.get(item.asset.id) ?? newIdempotencyKey()
    copyAttempts.current.set(item.asset.id, key)
    try {
      const link = await createLink(item.asset.id, key)
      copyAttempts.current.delete(item.asset.id)
      const ok = await copyText(link.shareUrl)
      setNotice(ok ? null : { tone: 'error', text: '复制失败，请检查剪贴板权限后重试' })
      if (!ok) setPreview(item)
      return ok
    } catch {
      setNotice({ tone: 'error', text: '创建链接失败，请重试' })
      return false
    }
  }

  const send = async (text: string) => {
    if (textAttempt.current?.text !== text) textAttempt.current = { text, key: newIdempotencyKey() }
    try {
      const item = await postText(roomId, text, textAttempt.current.key)
      textAttempt.current = null
      room.addItem(item)
      setNotice(null)
      return true
    } catch {
      setNotice({ tone: 'error', text: '发送失败，文字已保留在输入框' })
      return false
    }
  }

  const onDelete = (item: RoomItem) => {
    setDeleteError(null)
    setDeleteTarget(item)
  }
  const confirmDelete = async () => {
    const item = deleteTarget
    if (!item || deletePending.current) return
    deletePending.current = true
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteItem(roomId, item.id)
      room.removeItem(item.id)
      setDeleteTarget(null)
    } catch {
      setDeleteError('删除失败，请重试')
    } finally {
      deletePending.current = false
      setDeleting(false)
    }
  }

  // Copy feedback lives on the button itself (CopyButton shows a check for ~2s). Only failures
  // use the top notice so success never yanks reading position.
  const onCopy = async (text: string) => {
    const ok = await copyText(text)
    if (!ok) setNotice({ tone: 'error', text: '无法复制，请手动选择文字' })
    return ok
  }

  // Copies the rendered image bytes (not the URL): fetch the private content URL, then write the
  // blob to the clipboard. Falls back to copying the download link when the image cannot be read.
  const onCopyImage = async (item: AssetItem) => {
    const url = `/api/v1/assets/${encodeURIComponent(item.asset.id)}/content`
    try {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
        return true
      }
      throw new Error('clipboard unavailable')
    } catch {
      const link = `${window.location.origin}/d/`
      const ok = await copyText(link)
      if (!ok) setNotice({ tone: 'error', text: '图片复制失败，请长按保存' })
      else setNotice({ tone: 'error', text: '图片无法直接复制，已复制下载链接' })
      return ok
    }
  }

  const closeBack = () => {
    setBackOpen(false)
    setBackBusy(null)
    setBackError(null)
  }

  // Leave/close from the back dialog: only 204 counts as success. On timeout or 5xx the request may
  // have landed, so re-read the session memberships and room snapshot before deciding.
  const confirmBackAction = async (action: 'leave' | 'close') => {
    if (backRef.current) return
    backRef.current = true
    setBackBusy(action)
    setBackError(null)
    try {
      if (action === 'leave') await leaveRoom(roomId)
      else await closeRoom(roomId)
      notifySessionChanged()
      session.refresh()
      navigate('/', { replace: true })
    } catch (error) {
      const verified = await reverifyAfterWriteError(error, roomId, activeSession)
      if (verified === 'gone') {
        // The write landed even though the response was lost: treat it as success.
        notifySessionChanged()
        session.refresh()
        navigate('/', { replace: true })
        return
      }
      if (verified === 'stay') {
        setBackError(action === 'leave' ? '离开未成功，请重试' : '关闭未成功，请重试')
        return
      }
      if (isApiError(error) && error.code === 'OWNER_MUST_CLOSE') {
        setBackError('房主不能直接离开，请选择保留房间或关闭房间')
      } else if (isApiError(error) && (error.code === 'OWNER_REQUIRED' || error.code === 'FORBIDDEN')) {
        setBackError('已没有管理权限')
      } else if (isApiError(error) && error.status === 404) {
        notifySessionChanged()
        session.refresh()
        navigate('/', { replace: true })
      } else if (isApiError(error) && error.status === 429) {
        setBackError(error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试')
      } else {
        setBackError('操作未完成，请重试')
      }
    } finally {
      backRef.current = false
      setBackBusy(null)
    }
  }

  if (room.loading || sessionState.phase === 'loading') {
    return (
      <Shell title="正在进入房间">
        <div className="flex flex-1 items-center justify-center gap-3 text-sm text-muted"><Spinner />加载中</div>
      </Shell>
    )
  }

  if (!room.gone && !room.room && room.error) {
    return (
      <Shell title="暂时无法加载">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <StatusLine tone="error">网络或服务暂时不可用，请重试。</StatusLine>
          <Button onClick={room.refresh}>重新加载</Button>
        </div>
      </Shell>
    )
  }

  if (room.gone || !room.room) {
    return (
      <Shell title="房间不可用">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="text-muted">房间不存在、已关闭，或你已不再是成员。</p>
          <Button variant="primary" onClick={() => navigate('/')}>返回首页</Button>
        </div>
      </Shell>
    )
  }

  const current = room.room

  // The local cache is only a shortcut: without a server membership this device must not see content.
  // A stale session still shows the shell, but the room branch below still requires a membership.
  if (sessionState.phase === 'error') {
    return (
      <Shell title="暂时无法进入">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="text-muted">无法读取会话，请重试。</p>
          <Button variant="primary" onClick={session.refresh}>重试</Button>
        </div>
      </Shell>
    )
  }

  if (!membership) {
    return (
      <Shell title="房间不可用">
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
          <p className="text-muted">需要先通过房间号加入，才能查看内容。</p>
          <Button variant="primary" onClick={() => navigate('/')}>返回首页</Button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell
      title={current.code}
      label="房间"
      back={() => setBackOpen(true)}
      backLabel={isOwner ? '返回选项：保留房间或关闭房间' : '返回选项：保留房间或离开房间'}
      actions={(
        <>
          <RoomActions
            room={current}
            members={room.members}
            selfMemberId={selfMemberId}
            isOwner={isOwner}
            joinRequestTick={room.joinRequestTick}
            onChanged={() => void room.refreshDetails()}
            onLeft={() => navigate('/', { replace: true })}
            onOpenFiles={() => setFilesOpen(true)}
          />
          <ThemeToggle />
        </>
      )}
    >
      <BackDialog
        open={backOpen}
        isOwner={isOwner}
        code={current.code}
        busy={backBusy}
        error={backError}
        onClose={closeBack}
        onKeep={() => navigate('/')}
        onLeave={() => confirmBackAction('leave')}
        onCloseRoom={() => confirmBackAction('close')}
      />
      {env.isMock && <div className="px-4 pt-2 sm:px-8"><DevMockBadge /></div>}
      <div className="relative" aria-live="off">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col items-center gap-2 px-4 pt-3 sm:px-8">
          <RoomStatusToast
            key={roomErrorKey ?? 'ok'}
            errorKey={roomErrorKey}
            hasError={room.error !== null}
            connecting={roomConnecting}
            connectingMessage={roomConnectingMessage}
            flash={connectedFlash && room.error === null}
            onRetry={room.refresh}
          />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          const files = Array.from(event.dataTransfer.files)
          if (files.length) pickFiles(files)
        }}
      >
        {dragging && <div role="status" className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-canvas/95 p-6 text-center text-sm text-ink">松开即可上传文件</div>}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col items-center gap-2 px-4 pt-3 sm:px-8">
          <RoomToast show={notice !== null} tone={notice?.tone} message={notice?.text ?? ''} onClose={() => setNotice(null)} />
        </div>
        <MessageList
          items={room.items}
          members={room.members}
          selfMemberId={selfMemberId}
          isOwner={isOwner}
          freshIds={room.freshIds}
          hasOlder={room.nextCursor !== null}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          onDelete={onDelete}
          onCopy={onCopy}
          onCopyImage={onCopyImage}
          onCopyLink={copyItemLink}
          onDownload={downloadItem}
          onPreview={setPreview}
        />
        {uploads.entries.length > 0 && (
          <ul className="flex max-h-[30dvh] shrink-0 flex-col gap-2 overflow-y-auto border-t border-line px-4 py-3 sm:px-8" aria-label="上传队列">
            {uploads.entries.map((entry) => (
              <li key={entry.localId}>
                <AssetCard
                  asset={entry.asset}
                  mine
                  cancelling={entry.cancelPending}
                  progress={entry.progress}
                  onCancel={() => uploads.cancel(entry.localId)}
                  onRetry={() => uploads.retry(entry.localId)}
                />
                {entry.error && <p className="mt-1 text-xs text-danger">{entry.error}</p>}
                {!entry.cancelPending && (entry.status === 'cancelled' || entry.status === 'failed') && (
                  <span className="mt-1 flex items-center gap-3">
                    {entry.status === 'failed' && (
                      <button type="button" onClick={() => uploads.retry(entry.localId)} className="text-xs text-danger underline">重试</button>
                    )}
                    <button type="button" onClick={() => uploads.dismiss(entry.localId)} className="text-xs text-muted underline">移除</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <Composer
          disabled={false}
          onSend={send}
          onPickFiles={pickFiles}
          maxFileBytes={capabilities?.maxFileBytes}
        />
      </div>
      {preview && (
        <MediaPreview
          key={preview.id}
          asset={preview.asset}
          onClose={() => setPreview(null)}
          onCopyLink={preview.senderMemberId === selfMemberId || isOwner ? () => void copyItemLink(preview) : undefined}
        />
      )}
      <FileList
        open={filesOpen}
        roomId={current.id}
        items={room.items}
        uploads={uploads.entries}
        members={room.members}
        selfMemberId={selfMemberId}
        isOwner={isOwner}
        hasOlder={room.nextCursor !== null}
        loadingOlder={loadingOlder}
        itemsError={room.error}
        onLoadOlder={loadOlder}
        onPreview={setPreview}
        onDownload={downloadItem}
        onCopyLink={copyItemLink}
        onDelete={onDelete}
        onClose={() => setFilesOpen(false)}
      />
      <Dialog open={deleteTarget !== null} title="确认删除？" onClose={() => { if (!deletePending.current) setDeleteTarget(null) }}>
        <p className="text-sm leading-6 text-muted">删除后所有成员都将无法查看这条内容，此操作无法撤销。</p>
        {deleteTarget?.kind === 'asset' && <p className="mt-3 break-all text-sm">{deleteTarget.asset?.filename}</p>}
        {deleteError && <StatusLine tone="error">{deleteError}</StatusLine>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</Button>
          <Button variant="danger" busy={deleting} onClick={confirmDelete}>确认删除</Button>
        </div>
      </Dialog>
    </Shell>
  )
}

// Single-slot status toast. Error > connecting > connected-flash > hidden: content swaps
// in place (keyed fade on the text) instead of stacking a second pill below. Keyed by
// errorKey from the caller, so a fresh failure remounts and restarts the countdown.
function RoomStatusToast({ errorKey, hasError, connecting, connectingMessage, flash, onRetry }: {
  errorKey: string | null
  hasError: boolean
  connecting: boolean
  connectingMessage: string
  flash: boolean
  onRetry: () => void
}) {
  const [retryIn, setRetryIn] = useState(3)
  const [retrying, setRetrying] = useState(false)
  const fallback = useRef(0)
  const startRetry = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    setRetryIn(0)
    window.clearTimeout(fallback.current)
    // A refresh returns no completion signal when it fails with the same message. Never leave a
    // permaspinner: fall back to the countdown so the action is usable again.
    fallback.current = window.setTimeout(() => {
      setRetrying(false)
      setRetryIn(3)
    }, 2000)
    onRetry()
  }, [onRetry, retrying])
  useEffect(() => () => window.clearTimeout(fallback.current), [])
  const busy = retrying || retryIn <= 0
  useEffect(() => {
    if (errorKey === null || retrying) return
    if (retryIn <= 0) {
      const timer = window.setTimeout(startRetry, 0)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => setRetryIn((left) => left - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [errorKey, retryIn, retrying, startRetry])
  if (hasError) {
    return (
      <RoomToast
        show
        tone="error"
        busy={busy}
        message={<span key={`${errorKey}:${retryIn}:${busy}`} className="anim-fade">{busy ? '正在重新同步…' : `内容同步失败，${retryIn} 秒后自动重试。`}</span>}
        actionLabel={busy ? undefined : '立即重试'}
        onAction={startRetry}
      />
    )
  }
  if (connecting) return <RoomToast show busy message={<span key={connectingMessage} className="anim-fade">{connectingMessage}</span>} />
  if (flash) return <RoomToast show tone="success" message="已连接，内容是最新的。" />
  return <RoomToast show={false} message="" />
}

function BackDialog({ open, isOwner, code, busy, error, onClose, onKeep, onLeave, onCloseRoom }: {
  open: boolean
  isOwner: boolean
  code: string
  busy: 'leave' | 'close' | null
  error: string | null
  onClose: () => void
  onKeep: () => void
  onLeave: () => void
  onCloseRoom: () => void
}) {
  return (
    <Dialog open={open} title="返回首页" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-6 text-muted">
          {isOwner
            ? `回首页会保留房间 ${code}，稍后可从首页继续进入。关闭房间会让所有成员失去访问权限，分享链接也会失效。`
            : `回首页会保留房间 ${code}，稍后可从首页继续进入。离开后需要重新加入才能回来。`}
        </p>
        {error && <StatusLine tone="error">{error}</StatusLine>}
        <div className="flex flex-col gap-2">
          <Button variant="primary" disabled={busy !== null} onClick={onKeep} className="w-full">回首页保留房间</Button>
          {isOwner ? (
            <Button variant="danger" disabled={busy !== null} busy={busy === 'close'} onClick={onCloseRoom} className="w-full">关闭房间并返回</Button>
          ) : (
            <Button variant="secondary" disabled={busy !== null} busy={busy === 'leave'} onClick={onLeave} className="w-full">离开房间</Button>
          )}
          <Button variant="ghost" disabled={busy !== null} onClick={onClose} className="w-full">取消</Button>
        </div>
      </div>
    </Dialog>
  )
}

// A lost write response decides nothing by itself. Re-read the server state first: if this device no
// longer has a membership (or the snapshot is gone), the write landed even without a 204.
async function reverifyAfterWriteError(error: unknown, roomId: string, session: SessionState extends never ? never : import('@/shared/types/domain').Session | null): Promise<'gone' | 'stay' | 'unknown'> {
  if (!isApiError(error)) return 'unknown'
  // A timeout (status 0), gateway 5xx or a dropped connection can all hide a committed write.
  if (error.status !== 0 && error.status < 500) return 'unknown'
  try {
    const live = await fetchSession()
    const stillMember = live.memberships.some((m) => m.room.id === roomId)
    void session
    if (!stillMember) return 'gone'
  } catch {
    return 'unknown'
  }
  try {
    await fetchRoomSnapshot(roomId)
    return 'stay'
  } catch (snapshotError) {
    if (isApiError(snapshotError) && [401, 403, 404].includes(snapshotError.status)) return 'gone'
    return 'unknown'
  }
}

function Shell({
  title,
  label,
  back,
  backLabel,
  actions,
  children,
}: {
  title: string
  label?: string
  back?: () => void
  backLabel?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const viewportStyle = useViewportFrame()
  return (
    <div style={viewportStyle} className="flex h-dvh flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-8">
        {back && <IconButton icon="arrowLeft" label={backLabel ?? '返回首页'} onClick={back} size="sm" className="shrink-0" />}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-3 truncate font-mono text-base font-semibold tracking-[0.12em] sm:tracking-[0.15em]">
          {label && <span className="hidden font-sans text-sm font-normal tracking-normal text-muted sm:inline">{label}</span>}
          <span className="truncate">{title}</span>
        </h1>
        <div className="flex basis-full shrink-0 items-center justify-end gap-1.5 sm:basis-auto sm:gap-2">{actions}</div>
      </header>
      {children}
    </div>
  )
}
