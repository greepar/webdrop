import { useEffect, useRef, useState } from 'react'
import { assetKind, formatBytes } from '@/features/room/format'
import { IconButton } from '@/shared/ui/primitives'
import { CopyButton } from '@/shared/ui/CopyButton'
import { Icon, type IconName } from '@/shared/ui/Icon'
import { env } from '@/shared/config/env'
import { MediaPlayer } from '@/features/room/MediaPlayer'
import type { Asset } from '@/shared/types/domain'

type Props = {
  asset: Asset
  mine: boolean
  cancelling?: boolean
  progress?: { loaded: number; total: number } | null
  onPreview?: () => void
  onDownload?: () => void
  onCopyLink?: () => Promise<boolean>
  onCopyImage?: () => Promise<boolean>
  onDelete?: () => void
  onCancel?: () => void
  onRetry?: () => void
}

const statusText: Record<Asset['status'], string> = {
  pending: '等待上传',
  uploading: '上传中',
  ready: '可下载',
  failed: '上传失败',
  uploaded: '已上传，待确认',
  cancelled: '已取消',
  expired: '已过期',
}

const previewIcon = (kind: ReturnType<typeof assetKind>): IconName => {
  if (kind === 'image') return 'image'
  if (kind === 'video') return 'video'
  if (kind === 'audio') return 'play'
  return 'file'
}

function AssetActions({ filename, kind, mine, onPreview, onDownload, onCopyLink, onCopyImage, onDelete }: {
  filename: string
  kind: ReturnType<typeof assetKind>
  mine: boolean
  onPreview?: () => void
  onDownload?: () => void
  onCopyLink?: () => Promise<boolean>
  onCopyImage?: () => Promise<boolean>
  onDelete?: () => void
}) {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  if (!onPreview && !onDownload && !onCopyLink && !onCopyImage && !onDelete) return null
  const textAction = 'inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs text-muted transition-[color,background-color,transform] duration-150 ease-out hover:bg-surface hover:text-ink active:scale-[0.97] motion-reduce:active:scale-100'
  const pillAction = 'sketch-pill inline-flex min-h-9 items-center gap-1.5 border border-line bg-raised px-2.5 text-xs text-ink transition-[background-color,border-color,transform] duration-150 ease-out hover:border-line-strong active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100'
  const copy = async () => {
    if (!onCopyLink || copying) return
    setCopying(true)
    try {
      if (await onCopyLink()) {
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 2000)
      }
    } finally { setCopying(false) }
  }
  return (
    <div className="message-actions-clip message-actions-clip--asset">
      <div className={`message-copy-actions flex flex-wrap items-center gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
      {/* Images open a preview on click, so no separate preview button; other kinds keep it. */}
      {onPreview && kind !== 'image' && (
        <button type="button" onClick={onPreview} aria-label={`预览 ${filename}`} className={textAction}>
          <Icon name={previewIcon(kind)} className="size-3.5" />
          预览
        </button>
      )}
      {onDownload && (
        <button type="button" onClick={onDownload} aria-label={`下载 ${filename}`} className={pillAction}>
          <Icon name="download" className="size-3.5" />
          下载
        </button>
      )}
      {onCopyLink && (
        <button type="button" onClick={copy} disabled={copying} aria-label={`复制 ${filename} 的链接`} aria-busy={copying || undefined} aria-live="polite" className={`${pillAction} w-24 shrink-0 justify-center whitespace-nowrap ${copied ? 'text-success' : ''}`}>
          <Icon name={copied ? 'check' : copying ? 'clock' : 'copy'} className="size-3.5" />
          {copied ? '复制成功' : copying ? '复制中…' : '复制链接'}
        </button>
      )}
      {onCopyImage && (
        <CopyButton label={`复制图片 ${filename}`} size="sm" onCopy={onCopyImage} />
      )}
      {onDelete && (
        <IconButton icon="trash" label={`删除 ${filename}`} size="sm" tone="danger" onClick={onDelete} />
      )}
      </div>
    </div>
  )
}

// Asset cards share the message column; the status line is text, not colour alone.
export function AssetCard({ asset, mine, cancelling = false, progress, onPreview, onDownload, onCopyLink, onCopyImage, onDelete, onCancel, onRetry }: Props) {
  const kind = assetKind(asset.contentType)
  const icon: IconName = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file'
  const uploading = !cancelling && (asset.status === 'uploading' || asset.status === 'pending')
  const percent = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null
  const failed = asset.status === 'failed' || asset.status === 'expired' || asset.status === 'cancelled'
  const ready = asset.status === 'ready'
  const [mediaFailed, setMediaFailed] = useState(false)
  const mediaUrl = !env.isMock && ready && !mediaFailed
    ? `${env.apiBaseUrl}/assets/${encodeURIComponent(asset.id)}/content`
    : null
  const playable = mediaUrl !== null && !uploading && !failed
  const showActions = !env.isMock && ready && !uploading && !failed

  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    const placeholderIcon = kind === 'video' ? 'video' : kind === 'audio' ? 'play' : 'image'
    return (
      <figure className={`m-0 flex w-full max-w-full flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {playable && kind === 'video' ? (
          <MediaPlayer kind="video" src={mediaUrl} filename={asset.filename} onError={() => setMediaFailed(true)} />
        ) : playable && kind === 'audio' ? (
          <MediaPlayer kind="audio" src={mediaUrl} filename={asset.filename} onError={() => setMediaFailed(true)} />
        ) : playable && kind === 'image' ? (
          <button
            type="button"
            onClick={onPreview}
            disabled={!onPreview}
            aria-label={`预览 ${asset.filename}`}
            title={onPreview ? `预览 ${asset.filename}` : undefined}
            className={`sketch block max-w-full overflow-hidden border border-line bg-raised p-0 disabled:cursor-default ${onPreview ? 'cursor-zoom-in' : ''}`}
          >
            <img
              src={mediaUrl}
              alt={asset.filename}
              loading="lazy"
              draggable={false}
              onError={() => setMediaFailed(true)}
              className="anim-fade block max-h-[38dvh] w-auto max-w-full object-contain sm:max-h-[44dvh]"
            />
          </button>
        ) : (
          <span className="sketch grid h-32 w-52 place-items-center border border-line bg-raised text-muted" aria-hidden="true">
            <Icon name={placeholderIcon} className="size-8" />
          </span>
        )}
        <figcaption className={`mt-1.5 flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted ${mine ? 'justify-end text-right' : 'justify-start text-left'}`} title={asset.filename}>
          <span className="max-w-full truncate">{asset.filename}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(asset.sizeBytes)}</span>
          {failed && <span className="text-danger">· 上传失败</span>}
          {uploading && <span>· 上传中{percent !== null ? ` ${percent}%` : ''}</span>}
        </figcaption>
        {uploading && (
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-label={`${asset.filename} 上传进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out" style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} />
          </div>
        )}
        {showActions && (
          <AssetActions
            filename={asset.filename}
            kind={kind}
            mine={mine}
            onPreview={onPreview}
            onDownload={onDownload}
            onCopyLink={onCopyLink}
            onCopyImage={onCopyImage}
            onDelete={onDelete}
          />
        )}
      </figure>
    )
  }

  return (
    <div className="w-full min-w-64">
      <div
        className={`sketch flex w-full items-center gap-3 border p-3 pr-4 ${mine ? 'border-line-strong bg-mine' : 'border-line bg-raised'} ${failed ? 'border-danger' : ''}`}
      >
        <button
          type="button"
          onClick={onPreview}
          disabled={!ready || !onPreview}
          aria-label={`预览 ${asset.filename}`}
          className="grid size-12 shrink-0 place-items-center rounded-xl border border-line bg-canvas text-muted disabled:cursor-default"
        >
          <Icon name={icon} className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={asset.filename}>{asset.filename}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{formatBytes(asset.sizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span className={failed ? 'text-danger' : undefined}>{cancelling ? '正在取消…' : statusText[asset.status]}{percent !== null && uploading ? ` ${percent}%` : ''}</span>
          </p>
          {uploading && (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-label={`${asset.filename} 上传进度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out" style={{ transform: `scaleX(${(percent ?? 0) / 100})` }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(uploading || cancelling) && onCancel && (
            <button type="button" onClick={onCancel} disabled={cancelling} className="rounded-full px-3 py-2 text-xs text-muted hover:text-ink">取消</button>
          )}
          {failed && onRetry && (
            <button type="button" onClick={onRetry} className="rounded-full px-3 py-2 text-xs text-danger hover:underline">重试</button>
          )}
        </div>
      </div>
      {showActions && (
        <AssetActions
          filename={asset.filename}
          kind={kind}
          mine={mine}
          onPreview={onPreview}
          onDownload={onDownload}
          onCopyLink={onCopyLink}
          onCopyImage={onCopyImage}
          onDelete={onDelete}
        />
      )}
    </div>
  )
}
