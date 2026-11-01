import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { createLink, fetchRoomLinks, revokeLink } from '@/features/room/api'
import { formatRemaining } from '@/features/room/format'
import { copyText } from '@/shared/clipboard'
import { newIdempotencyKey } from '@/shared/api/session-token'
import type { ShareLink } from '@/shared/types/domain'

type Props = {
  assetId: string | null
  filename: string
  roomId: string
  onClose: () => void
}

// The list endpoint returns only the caller's links unless they own the room.
// Every returned link is therefore revocable by this session; the server still authorizes writes.
export function ShareSheet({ assetId, filename, roomId, onClose }: Props) {
  const createKey = useRef(newIdempotencyKey())
  const pending = useRef(false)
  const [links, setLinks] = useState<ShareLink[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const loading = assetId !== null && loadedFor !== assetId
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!assetId) return
    let cancelled = false
    const controller = new AbortController()
    fetchRoomLinks(roomId, controller.signal)
      .then((all) => {
        if (!cancelled) setLinks(all.filter((l) => l.assetId === assetId))
      })
      .catch(() => {
        if (!cancelled) setNotice({ tone: 'error', text: '无法读取已有链接' })
      })
      .finally(() => {
        if (!cancelled) setLoadedFor(assetId)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [assetId, roomId])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const create = async () => {
    if (!assetId || pending.current) return
    pending.current = true
    setBusy(true)
    setNotice(null)
    try {
      const link = await createLink(assetId, createKey.current)
      createKey.current = newIdempotencyKey()
      setLinks((list) => [link, ...list.filter((existing) => existing.id !== link.id)])
      setNotice({ tone: 'success', text: '已创建分享链接' })
    } catch {
      setNotice({ tone: 'error', text: '创建失败，请重试' })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const revoke = async (link: ShareLink) => {
    setBusy(true)
    try {
      await revokeLink(link.id)
      setLinks((list) => list.filter((l) => l.id !== link.id))
      setNotice({ tone: 'success', text: '链接已撤销' })
    } catch {
      setNotice({ tone: 'error', text: '撤销失败，请重试' })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const copy = async (value: string) => {
    const ok = await copyText(value)
    setNotice(ok ? { tone: 'success', text: '已复制' } : { tone: 'error', text: '无法复制，请长按链接手动复制' })
  }

  const active = links.filter((l) => !l.revokedAt && Date.parse(l.expiresAt) > now)

  return (
    <Dialog open={assetId !== null} title={`分享 ${filename}`} onClose={onClose}>
      <p className="text-sm leading-6 text-muted">有效期以创建结果为准。房间关闭或链接撤销后无法继续访问。</p>
      <div className="mt-5 flex flex-col gap-3">
        {loading && <p className="text-sm text-muted">正在读取链接…</p>}
        {!loading && active.length === 0 && <p className="text-sm text-muted">还没有有效链接。</p>}
        {active.map((link) => (
          <div key={link.id} className="sketch border border-line bg-canvas p-4">
            <p className="break-all font-mono text-xs text-ink">{link.shareUrl}</p>
            <p className="mt-2 text-xs text-muted">{formatRemaining(link.expiresAt, now)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => copy(link.shareUrl)} className="min-h-9 px-3 text-xs">
                <Icon name="copy" className="size-4" />
                复制分享页
              </Button>
              <Button variant="secondary" onClick={() => copy(link.contentUrl)} className="min-h-9 px-3 text-xs">
                <Icon name="link" className="size-4" />
                复制直链
              </Button>
              {(
                <Button variant="ghost" onClick={() => revoke(link)} disabled={busy} className="min-h-9 px-3 text-xs text-danger">
                  撤销
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-col gap-3">
        <Button variant="primary" busy={busy} onClick={create} className="w-full">创建分享链接</Button>
        <StatusLine tone={notice?.tone === 'error' ? 'error' : notice ? 'success' : 'info'}>{notice?.text}</StatusLine>
      </div>
    </Dialog>
  )
}
