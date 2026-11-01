import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dialog, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { formatBytes, formatTime } from '@/features/room/format'
import type { UploadEntry } from '@/features/room/use-uploads'
import { isAssetItem, type AssetItem, type Member, type RoomItem } from '@/shared/types/domain'
import { env } from '@/shared/config/env'

type Filter = 'all' | 'image' | 'video' | 'audio' | 'file'

type Props = {
  open: boolean
  roomId: string
  items: RoomItem[]
  uploads: UploadEntry[]
  members: Member[]
  selfMemberId: string
  isOwner: boolean
  hasOlder: boolean
  loadingOlder: boolean
  itemsError: { code: string; message: string } | null
  onLoadOlder: () => void
  onPreview: (item: AssetItem) => void
  onDownload: (item: AssetItem) => void
  onCopyLink: (item: AssetItem) => Promise<boolean>
  onDelete: (item: RoomItem) => void
  onClose: () => void
}

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'file', label: '文件' },
]

function kindOf(contentType: string): 'image' | 'video' | 'audio' | 'file' {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  return 'file'
}

// Attachments share the message column's RoomItem state: the list only filters already-loaded
// items plus in-flight uploads. There is no dedicated attachment endpoint: the contract exposes
// items pagination only, so search/filter never claim to cover unloaded history.
export function FileList({ open, roomId, items, uploads, members, selfMemberId, isOwner, hasOlder, loadingOlder, itemsError, onLoadOlder, onPreview, onDownload, onCopyLink, onDelete, onClose }: Props) {
  void roomId
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.displayName])), [members])

  const attachments = useMemo(() => {
    const rows = items.filter(isAssetItem)
    const q = query.trim().toLowerCase()
    return rows
      .filter((item) => {
        if (filter !== 'all' && kindOf(item.asset.contentType) !== filter) return false
        if (q && !item.asset.filename.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [items, filter, query])

  const counts = useMemo(() => {
    const rows = items.filter(isAssetItem)
    return {
      all: rows.length,
      image: rows.filter((i) => kindOf(i.asset.contentType) === 'image').length,
      video: rows.filter((i) => kindOf(i.asset.contentType) === 'video').length,
      audio: rows.filter((i) => kindOf(i.asset.contentType) === 'audio').length,
      file: rows.filter((i) => kindOf(i.asset.contentType) === 'file').length,
    }
  }, [items])

  return (
    <Dialog open={open} title={`文件（已加载 ${attachments.length} 项）`} onClose={onClose}>
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="附件筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`sketch-pill inline-flex min-h-9 items-center px-3.5 text-xs font-medium transition-[background-color,border-color,color] duration-150 ease-out ${filter === f.key ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-raised text-ink hover:border-line-strong'}`}
            >
              {f.label} {counts[f.key]}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <label htmlFor="file-search" className="sr-only">按文件名搜索已加载附件</label>
          <input
            id="file-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按文件名搜索（仅已加载）"
            className="sketch min-h-11 w-full border border-line-strong bg-raised px-3 text-[16px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)]"
          />
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">仅展示当前已加载的消息附件；加载更多历史后这里会自动补齐，不会为搜索拉取全部历史。</p>
        <div className="mt-3">
          {uploads.length > 0 && (
            <ul className="mb-3 flex flex-col gap-2" aria-label="正在上传">
              {uploads.map((entry) => (
                <li key={entry.localId} className="sketch flex items-center gap-3 border border-dashed border-line-strong bg-raised p-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-canvas text-muted" aria-hidden="true">
                    <Icon name="file" className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{entry.file.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">{entry.cancelPending ? '正在取消…' : entry.status === 'failed' ? (entry.error ?? '上传失败') : `上传中${entry.progress ? ` ${Math.round((entry.progress.loaded / entry.progress.total) * 100)}%` : ''}`}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {itemsError && (
            <div className="mb-3"><StatusLine tone="error">内容同步失败：{itemsError.message}。列表为已加载快照。</StatusLine></div>
          )}
          {attachments.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              {items.filter(isAssetItem).length === 0 ? '还没有附件。发送图片、视频或文件后会出现在这里。' : '当前筛选没有匹配的附件。'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {attachments.map((item) => (
                <AttachmentCard
                  key={item.id}
                  item={item}
                  sender={item.senderMemberId === selfMemberId ? '我' : (memberName.get(item.senderMemberId) ?? '成员')}
                  canDelete={isOwner || item.senderMemberId === selfMemberId}
                  onPreview={() => onPreview(item)}
                  onDownload={() => onDownload(item)}
                  onCopyLink={() => onCopyLink(item)}
                  onAskDelete={() => onDelete(item)}
                />
              ))}
            </ul>
          )}
          {hasOlder && (
            <div className="mt-4 flex justify-center">
              <Button variant="ghost" onClick={onLoadOlder} busy={loadingOlder} className="min-h-9 px-3 text-xs">加载更早的附件</Button>
            </div>
          )}
          {!hasOlder && attachments.length > 0 && (
            <p className="mt-4 text-center text-xs text-muted">已加载全部历史中的 {attachments.length} 项附件。</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function AttachmentCard({ item, sender, canDelete, onPreview, onDownload, onCopyLink, onAskDelete }: {
  item: AssetItem
  sender: string
  canDelete: boolean
  onPreview: () => void
  onDownload: () => void
  onCopyLink: () => Promise<boolean>
  onAskDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  const copy = async () => {
    if (copyPending.current) return
    copyPending.current = true
    setCopying(true)
    try {
      if (await onCopyLink()) {
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 2000)
      }
    } finally {
      copyPending.current = false
      setCopying(false)
    }
  }
  const kind = kindOf(item.asset.contentType)
  const icon = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file'
  const url = env.isMock ? null : `${env.apiBaseUrl}/assets/${encodeURIComponent(item.asset.id)}/content`
  const ready = item.asset.status === 'ready'
  return (
    <li className="sketch border border-line bg-raised p-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onPreview}
          disabled={!ready}
          aria-label={`预览 ${item.asset.filename}`}
          className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-canvas text-muted disabled:cursor-default"
        >
          {kind === 'image' && url ? (
            <img src={url} alt="" aria-hidden="true" loading="lazy" className="size-full object-cover" />
          ) : (
            <Icon name={icon} className="size-6" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.asset.filename}>{item.asset.filename}</p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {formatBytes(item.asset.sizeBytes)} · {sender} · {formatTime(item.createdAt)}
            {item.asset.status !== 'ready' ? ` · ${item.asset.status}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button variant="secondary" onClick={onDownload} disabled={!ready} className="min-h-9 flex-1 px-3 text-xs">下载</Button>
        <Button variant="ghost" onClick={copy} disabled={!ready || copying} aria-live="polite" className={`min-h-9 flex-1 px-3 text-xs ${copied ? 'text-success' : ''}`}>
          <Icon name={copied ? 'check' : 'link'} className="size-3.5" />
          {copied ? '复制成功' : copying ? '复制中…' : '复制链接'}
        </Button>
        {canDelete && (
          <Button variant="ghost" onClick={onAskDelete} className="min-h-9 px-3 text-xs text-danger">删除</Button>
        )}
      </div>

    </li>
  )
}
