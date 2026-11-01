import { assetKind, formatBytes } from '@/features/room/format'
import { Icon, type IconName } from '@/shared/ui/Icon'
import type { Asset } from '@/shared/types/domain'

type Props = {
  asset: Asset
  mine: boolean
  cancelling?: boolean
  progress?: { loaded: number; total: number } | null
  onPreview?: () => void
  onShare?: () => void
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

// Asset cards share the message column; the status line is text, not colour alone.
export function AssetCard({ asset, mine, cancelling = false, progress, onPreview, onShare, onCancel, onRetry }: Props) {
  const kind = assetKind(asset.contentType)
  const icon: IconName = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file'
  const uploading = !cancelling && (asset.status === 'uploading' || asset.status === 'pending')
  const percent = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null
  const failed = asset.status === 'failed' || asset.status === 'expired' || asset.status === 'cancelled'
  const ready = asset.status === 'ready'

  return (
    <div
      className={`sketch flex w-full min-w-64 items-center gap-3 border p-3 pr-4 ${mine ? 'border-line-strong bg-mine' : 'border-line bg-raised'} ${failed ? 'border-danger' : ''}`}
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
        {ready && onShare && (
          <button type="button" onClick={onShare} aria-label={`分享 ${asset.filename}`} className="grid size-9 place-items-center rounded-full text-muted hover:text-ink">
            <Icon name="link" className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
