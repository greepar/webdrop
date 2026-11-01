import { useState } from 'react'
import { Button, Dialog, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { env } from '@/shared/config/env'
import type { Asset } from '@/shared/types/domain'
import { MediaPlayer } from './MediaPlayer'
import { formatBytes } from './format'

export function MediaPreview({ asset, onClose, onCopyLink }: { asset: Asset; onClose: () => void; onCopyLink?: () => void | Promise<void> }) {
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const url = `${env.apiBaseUrl}/assets/${encodeURIComponent(asset.id)}/content`
  const image = asset.contentType.startsWith('image/')
  const video = asset.contentType.startsWith('video/')
  const audio = asset.contentType.startsWith('audio/')
  if (image && !env.isMock && !failed) {
    return (
      <Dialog open lightbox title={asset.filename} onClose={onClose}>
        <img
          src={url}
          alt={asset.filename}
          onError={() => setFailed(true)}
          draggable={false}
          onClick={onClose}
          className="block max-h-[92dvh] max-w-[96vw] object-contain"
        />
      </Dialog>
    )
  }
  return (
    <Dialog open expanded={image || video} title={asset.filename} onClose={onClose}>
      <p className="mb-4 text-sm text-muted">{formatBytes(asset.sizeBytes)}</p>
      {env.isMock ? (
        <StatusLine>开发 mock 不提供文件字节，请连接真实服务验证预览和下载。</StatusLine>
      ) : (
        <>
          {image && !failed && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setZoomed((z) => !z)}
                aria-label={zoomed ? `缩小 ${asset.filename}` : `放大 ${asset.filename}`}
                aria-pressed={zoomed}
                title={zoomed ? '点击缩小' : '点击放大'}
                className="block h-[65dvh] w-full cursor-zoom-in overflow-auto rounded-xl border border-line bg-canvas outline-none focus-visible:outline-2 focus-visible:outline-accent data-[zoomed=true]:cursor-zoom-out"
                data-zoomed={zoomed}
              >
                <img
                  src={url}
                  alt={asset.filename}
                  onError={() => setFailed(true)}
                  draggable={false}
                  className={zoomed ? 'block max-w-none w-[175%] h-auto' : 'block h-full w-full object-contain'}
                />
              </button>
              <span className="pointer-events-none absolute right-2 top-2 rounded-full border border-line bg-raised/90 px-2 py-0.5 text-[11px] text-muted">
                {zoomed ? '点击缩小' : '点击放大'}
              </span>
            </div>
          )}
          {video && !failed && <MediaPlayer kind="video" src={url} filename={asset.filename} variant="preview" onError={() => setFailed(true)} />}
          {audio && !failed && <MediaPlayer kind="audio" src={url} filename={asset.filename} variant="preview" onError={() => setFailed(true)} />}
          {failed && <StatusLine tone="error">无法预览，文件可能已失效，或浏览器不支持此格式。可以尝试下载。</StatusLine>}
          {!image && !video && !audio && <StatusLine>此格式不支持在线预览，请下载后打开。</StatusLine>}
          <div className="mt-5 flex flex-wrap gap-2">
            <a href={url} download={asset.filename} className="sketch-pill inline-flex min-h-11 items-center gap-2 border border-accent bg-accent px-5 text-sm text-accent-ink">
              <Icon name="download" className="size-4" />
              下载文件
            </a>
            {onCopyLink && (
              <Button variant="secondary" onClick={onCopyLink} className="min-h-11 px-4">
                <Icon name="copy" className="size-4" />
                复制链接
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
