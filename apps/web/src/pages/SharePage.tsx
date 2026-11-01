import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isApiError, isAbortError } from '@/shared/api/errors'
import { fetchSharedAsset } from '@/features/room/api'
import { formatBytes, formatRemaining, assetKind } from '@/features/room/format'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { Button, DevMockBadge, Spinner } from '@/shared/ui/primitives'
import { BrandMark, Icon } from '@/shared/ui/Icon'
import { env } from '@/shared/config/env'
import type { SharedAsset } from '@/shared/types/domain'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; info: SharedAsset }
  | { phase: 'unavailable'; reason: 'expired' | 'missing' | 'error' }

export function SharePage() {
  const { slug = '' } = useParams()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [loadedSlug, setLoadedSlug] = useState(slug)

  if (loadedSlug !== slug) {
    setLoadedSlug(slug)
    setState({ phase: 'loading' })
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchSharedAsset(encodeURIComponent(slug), controller.signal)
      .then((info) => { if (!controller.signal.aborted) setState({ phase: 'ready', info }) })
      .catch((error) => {
        if (isAbortError(error)) return
        // The server reports revoked and expired shares with the same code (SHARE_EXPIRED).
        const reason = isApiError(error) && error.status === 410
          ? 'expired'
          : isApiError(error) && error.status === 404 ? 'missing' : 'error'
        setState({ phase: 'unavailable', reason })
      })
    return () => controller.abort()
  }, [slug, version])

  const expiresAt = state.phase === 'ready' ? state.info.expiresAt : null
  useEffect(() => {
    if (!expiresAt) return
    const remaining = Date.parse(expiresAt) - Date.now()
    if (!Number.isFinite(remaining)) return
    // Ask the server at the displayed deadline; a local clock never revokes access.
    const timer = window.setTimeout(() => setVersion(value => value + 1), Math.max(1000, remaining + 1000))
    return () => window.clearTimeout(timer)
  }, [expiresAt])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="flex min-h-dvh flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-8">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" className="text-sm text-muted underline-offset-4 hover:underline">WebDrop</Link>
        <div className="flex items-center gap-3">
          {env.isMock && <DevMockBadge />}
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center py-10">
        {state.phase === 'loading' && (
          <div className="flex items-center gap-3 text-sm text-muted"><Spinner />正在打开分享…</div>
        )}

        {state.phase === 'ready' && (
          <section className="anim-enter flex w-full max-w-md flex-col items-center gap-6 text-center" aria-labelledby="share-title">
            <BrandMark className="size-20" />
            <div>
              <h1 id="share-title" className="break-all text-2xl font-semibold tracking-tight">{state.info.asset.filename}</h1>
              <p className="mt-2 text-sm text-muted">
                {formatBytes(state.info.asset.sizeBytes)} · {assetKind(state.info.asset.contentType) === 'file' ? '文件' : '媒体'} · {formatRemaining(state.info.expiresAt, now)}
              </p>
            </div>
            <a
              href={state.info.contentUrl}
              download={state.info.asset.filename}
              className="sketch-pill inline-flex min-h-12 items-center gap-2 border border-accent bg-accent px-6 text-sm font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90"
            >
              <Icon name="download" className="size-5" />
              下载文件
            </a>
            <p className="text-xs leading-5 text-muted">下载没有开始？长按上方按钮，选择保存。</p>
          </section>
        )}

        {state.phase === 'unavailable' && (
          <section className="anim-enter flex max-w-sm flex-col items-center gap-4 text-center" aria-labelledby="share-title">
            <h1 id="share-title" className="text-2xl font-semibold tracking-tight">{unavailableTitle(state.reason)}</h1>
            <p className="text-sm leading-6 text-muted">{unavailableBody(state.reason)}</p>
            {state.reason === 'error' && <Button onClick={() => { setState({ phase: 'loading' }); setVersion(value => value + 1) }}>重试</Button>}
          </section>
        )}
      </main>
    </div>
  )
}

function unavailableTitle(reason: 'expired' | 'missing' | 'error') {
  return { expired: '链接已失效', missing: '找不到这个分享', error: '暂时无法打开' }[reason]
}

function unavailableBody(reason: 'expired' | 'missing' | 'error') {
  return {
    expired: '链接已过期或被撤销，请联系分享者获取新链接。',
    missing: '链接可能输入有误，或内容已不再分享。',
    error: '网络或服务暂时不可用，请稍后刷新重试。',
  }[reason]
}
