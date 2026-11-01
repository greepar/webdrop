import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useViewportFrame } from '@/shared/browser/use-viewport-frame'
import { useCapabilities } from '@/features/entry/use-capabilities'
import { formatBytes } from '@/features/room/format'
import { useRoom } from '@/features/room/use-room'
import { useUploads } from '@/features/room/use-uploads'
import { MediaPreview } from '@/features/room/MediaPreview'
import { MessageList } from '@/features/room/MessageList'
import { Composer } from '@/features/room/Composer'
import { RoomActions } from '@/features/room/RoomActions'
import { ShareSheet } from '@/features/room/ShareSheet'
import { AssetCard } from '@/features/room/AssetCard'
import { deleteItem, postText } from '@/features/room/api'
import { findMembership, roleOf, useSession } from '@/features/session/use-session'
import { newIdempotencyKey } from '@/shared/api/session-token'
import { copyText } from '@/shared/clipboard'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Button, DevMockBadge, IconButton, Spinner, StatusLine } from '@/shared/ui/primitives'
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
  const [shareTarget, setShareTarget] = useState<{ assetId: string; filename: string } | null>(null)
  const [preview, setPreview] = useState<AssetItem | null>(null)
  const textAttempt = useRef<{ text: string; key: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const room = useRoom(roomId)
  const session = useSession()
  const { capabilities } = useCapabilities()
  const membership = findMembership(session.state.phase === 'ready' ? session.state.session : null, roomId)
  const selfMemberId = membership?.membership.id ?? ''
  const isOwner = roleOf(membership) === 'owner'
  const onUploadComplete = useCallback((item: RoomItem) => room.addItem(item), [room])
  const uploads = useUploads(roomId, onUploadComplete)
  const { abortAll } = uploads
  useEffect(() => { if (room.gone) abortAll() }, [room.gone, abortAll])

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

  const openShare = (item: AssetItem) => setShareTarget({ assetId: item.asset.id, filename: item.asset.filename })

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

  const onDelete = async (item: RoomItem) => {
    try {
      await deleteItem(roomId, item.id)
      room.removeItem(item.id)
    } catch {
      setNotice({ tone: 'error', text: '删除失败，请重试' })
    }
  }

  const onCopy = async (text: string) => {
    const ok = await copyText(text)
    setNotice(ok ? { tone: 'success', text: '已复制' } : { tone: 'error', text: '无法复制，请手动选择文字' })
  }

  if (room.loading || session.state.phase === 'loading') {
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

  if (session.state.phase === 'error') {
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
      back={() => navigate('/')}
      actions={(
        <>
          <RoomActions
            room={current}
            members={room.members}
            selfMemberId={selfMemberId}
            isOwner={isOwner}
            onChanged={() => void room.refreshDetails()}
            onLeft={() => navigate('/', { replace: true })}
          />
          <ThemeToggle />
        </>
      )}
    >
      {env.isMock && <div className="px-4 pt-2 sm:px-8"><DevMockBadge /></div>}
      {room.error && (
        <div className="px-4 pt-3 sm:px-8">
          <StatusLine tone="error">内容同步失败。</StatusLine>
          <Button variant="ghost" onClick={room.refresh}>重新同步</Button>
        </div>
      )}
      {(room.connection === 'connecting' || room.connection === 'reconnecting') && (
        <div className="px-4 pt-3 sm:px-8"><StatusLine>{room.connection === 'connecting' ? '正在连接实时更新…' : '连接中断，正在重连…'}</StatusLine></div>
      )}
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
        {notice && (
          <div className="px-4 pt-3 sm:px-8">
            <StatusLine tone={notice.tone}>{notice.text}</StatusLine>
          </div>
        )}
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
          onShare={openShare}
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
                  <button type="button" onClick={() => uploads.dismiss(entry.localId)} className="mt-1 text-xs text-muted underline">移除</button>
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
      {preview && <MediaPreview key={preview.id} asset={preview.asset} onClose={() => setPreview(null)} />}
      {shareTarget && <ShareSheet
        key={shareTarget.assetId}
        assetId={shareTarget?.assetId ?? null}
        filename={shareTarget?.filename ?? ''}
        roomId={current.id}
        onClose={() => setShareTarget(null)}
      />}
    </Shell>
  )
}

function Shell({
  title,
  label,
  back,
  actions,
  children,
}: {
  title: string
  label?: string
  back?: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const viewportStyle = useViewportFrame()
  return (
    <div style={viewportStyle} className="flex h-dvh flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-8">
        {back && <IconButton icon="arrowLeft" label="返回首页" onClick={back} size="sm" className="shrink-0" />}
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
