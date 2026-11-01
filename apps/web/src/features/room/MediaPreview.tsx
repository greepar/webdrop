import { useState } from 'react'
import { Dialog, StatusLine } from '@/shared/ui/primitives'
import { env } from '@/shared/config/env'
import type { Asset } from '@/shared/types/domain'
import { formatBytes } from './format'

export function MediaPreview({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [failed, setFailed] = useState(false)
  const url = `${env.apiBaseUrl}/assets/${encodeURIComponent(asset.id)}/content`
  const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.contentType)
  const video = asset.contentType === 'video/mp4'
  return (
    <Dialog open title={asset.filename} onClose={onClose}>
      <p className="mb-4 text-sm text-muted">{formatBytes(asset.sizeBytes)}</p>
      {env.isMock ? (
        <StatusLine>开发 mock 不提供文件字节，请连接真实服务验证预览和下载。</StatusLine>
      ) : (
        <>
          {image && !failed && <img src={url} alt={asset.filename} className="max-h-[55dvh] w-full object-contain" onError={() => setFailed(true)} />}
          {video && !failed && <video src={url} controls playsInline preload="metadata" className="max-h-[55dvh] w-full" onError={() => setFailed(true)} />}
          {failed && <StatusLine tone="error">无法预览，文件可能已失效，或浏览器不支持此格式。可以尝试下载。</StatusLine>}
          {!image && !video && <StatusLine>此格式不支持在线预览，请下载后打开。</StatusLine>}
          <a href={url} download={asset.filename} className="sketch-pill mt-5 inline-flex min-h-11 items-center border border-accent bg-accent px-5 text-sm text-accent-ink">下载文件</a>
        </>
      )}
    </Dialog>
  )
}
