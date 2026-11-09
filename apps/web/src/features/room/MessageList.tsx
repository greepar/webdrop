import { useLayoutEffect, useRef, useState } from 'react'
import { formatTime } from '@/features/room/format'
import { Button, IconButton } from '@/shared/ui/primitives'
import { CopyButton } from '@/shared/ui/CopyButton'
import { Icon } from '@/shared/ui/Icon'
import { isAssetItem, type AssetItem, type Member, type RoomItem } from '@/shared/types/domain'
import { AssetCard } from '@/features/room/AssetCard'

const NEAR_BOTTOM_PX = 96

type Props = {
  items: RoomItem[]
  members: Member[]
  selfMemberId: string
  isOwner: boolean
  freshIds?: readonly string[]
  hasOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  onDelete: (item: RoomItem) => void
  onCopy: (text: string) => Promise<boolean>
  onCopyImage: (item: AssetItem) => Promise<boolean>
  onCopyLink: (item: AssetItem) => Promise<boolean>
  onDownload: (item: AssetItem) => void
  onPreview: (item: AssetItem) => void
}

// Follows new messages only while the reader is near the bottom; otherwise keeps the scroll position
// and shows a "new messages" pill instead of jumping.
export function MessageList({ items, members, selfMemberId, isOwner, freshIds = [], hasOlder, loadingOlder, onLoadOlder, onDelete, onCopy, onCopyImage, onCopyLink, onDownload, onPreview }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const previousItems = useRef<RoomItem[]>([])
  const anchorRef = useRef<{ height: number; top: number; count: number; element: HTMLElement | null; offset: number } | null>(null)
  const readingAnchors = useRef<Array<{ id: string; offset: number }>>([])
  const [unseen, setUnseen] = useState(0)
  const memberName = new Map(members.map((m) => [m.id, m.displayName]))

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const el = scrollRef.current
    if (!el) return
    // Programmatic scrolls don't always fire enough scroll events (smooth), so mark
    // the intent immediately; the onScroll handler will confirm it afterwards.
    nearBottomRef.current = true
    setUnseen(0)
    if (behavior === 'auto' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollTop = el.scrollHeight - el.clientHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior })
    }
  }

  // Stick to the bottom while the user is near it: images, fonts and late layout
  // grow scrollHeight after the items effect already ran. Re-pin on any size change
  // instead of leaving the last message half-cut (needs one more wheel swipe).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const pin = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (nearBottomRef.current && !anchorRef.current && el.isConnected) {
          el.scrollTop = el.scrollHeight - el.clientHeight
        }
      })
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pin) : null
    ro?.observe(el)
    const list = el.querySelector('ol')
    if (list) ro?.observe(list)
    // First paint: fonts/images may still be pending; one extra pin settles it.
    pin()
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const previous = previousItems.current
    previousItems.current = items
    if (items.length === 0) return
    if (previous.length === 0) {
      scrollToBottom('auto')
      return
    }
    const el = scrollRef.current
    if (el && !nearBottomRef.current && !anchorRef.current) {
      const rows = new Map(Array.from(el.querySelectorAll<HTMLElement>('[data-item-id]')).map(row => [row.dataset.itemId, row]))
      for (const anchor of readingAnchors.current) {
        const row = rows.get(anchor.id)
        if (!row) continue
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset
        break
      }
    }
    const last = previous.at(-1)!
    const known = new Set(previous.map((item) => item.id))
    const lastIndex = items.findIndex(item => item.id === last.id)
    const arriving = new Set(items.filter((item, index) => !known.has(item.id) &&
      !anchorRef.current && (lastIndex >= 0 ? index > lastIndex : item.createdAt > last.createdAt)).map(item => item.id))
    const added = arriving.size
    if (added <= 0) return
    for (const row of scrollRef.current?.querySelectorAll<HTMLElement>('[data-item-id]') ?? []) {
      if (arriving.has(row.dataset.itemId ?? '')) {
        const item = items.find(item => item.id === row.dataset.itemId)
        if (item) row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
      }
    }
    if (nearBottomRef.current) {
      scrollToBottom('smooth')
    } else {
      setUnseen((count) => count + added)
    }
  }, [items])

  const loadOlder = () => {
    const el = scrollRef.current
    if (!el || loadingOlder || anchorRef.current) return
    const element = Array.from(el.querySelectorAll<HTMLElement>('article')).find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top) ?? null
    anchorRef.current = { height: el.scrollHeight, top: el.scrollTop, count: items.length, element, offset: element ? element.getBoundingClientRect().top - el.getBoundingClientRect().top : 0 }
    onLoadOlder()
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    readingAnchors.current = Array.from(el.querySelectorAll<HTMLElement>('[data-item-id]')).filter(row => row.getBoundingClientRect().top >= top).slice(0, 4).map(row => ({ id: row.dataset.itemId!, offset: row.getBoundingClientRect().top - top }))
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = distance < NEAR_BOTTOM_PX
    if (nearBottomRef.current && unseen) setUnseen(0)
    if (el.scrollTop < 120 && hasOlder && !loadingOlder) {
      loadOlder()
    }
  }

  // Older pages are prepended above the viewport; restore the reader's position by the height delta.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return
    if (items.length > anchor.count) {
      el.scrollTop = anchor.element?.isConnected ? el.scrollTop + anchor.element.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset : anchor.top + (el.scrollHeight - anchor.height)
      anchorRef.current = null
    } else if (!loadingOlder) {
      anchorRef.current = null
    }
  }, [items, loadingOlder])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="[overflow-anchor:none] h-full overflow-y-auto overscroll-contain px-4 py-5 sm:px-8"
        role="log"
        aria-label="房间内容"
        aria-live="polite"
      >
        {hasOlder && (
          <div className="mb-4 flex justify-center">
            <Button variant="ghost" onClick={loadOlder} busy={loadingOlder} className="min-h-9 px-3 text-xs">
              {loadingOlder ? '正在加载' : '加载更早的内容'}
            </Button>
          </div>
        )}
        {items.length === 0 && (
          <p className="anim-fade mt-16 text-center text-sm text-muted">还没有内容。输入文字，或添加文件开始分享。</p>
        )}
        <ol className="flex flex-col gap-4">
          {items.map((item) => {
            const mine = item.senderMemberId === selfMemberId
            const sender = memberName.get(item.senderMemberId) ?? '成员'
            return (
              <li key={item.id} data-item-id={item.id} className={`flex w-full ${freshIds.includes(item.id) ? 'anim-message' : ''} ${mine ? 'justify-end' : 'justify-start'}`}>
                <article className={`message-bubble group flex min-w-0 max-w-[min(34rem,88%)] flex-col gap-1.5 ${mine ? 'items-end' : 'items-start'}`}>
                  <header className="flex items-center gap-2 px-1 text-xs text-muted">
                    <span className="font-medium text-ink">{mine ? '我' : sender}</span>
                    <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
                  </header>
                  {item.kind === 'text' ? (
                    <div className={`sketch min-w-0 max-w-full border px-4 py-3 text-[15px] leading-7 whitespace-pre-wrap [overflow-wrap:anywhere] ${mine ? 'border-line-strong bg-mine' : 'border-line bg-raised'}`}>
                      {item.text ?? ''}
                    </div>
                  ) : isAssetItem(item) ? (
                    <AssetCard
                      asset={item.asset}
                      mine={mine}
                      onPreview={() => onPreview(item)}
                      onDownload={() => onDownload(item)}
                      onCopyLink={mine || isOwner ? () => onCopyLink(item) : undefined}
                      onCopyImage={item.asset.contentType.startsWith('image/') ? () => onCopyImage(item) : undefined}
                      onDelete={mine || isOwner ? () => onDelete(item) : undefined}
                    />
                  ) : null}
                  <div className="message-actions-clip message-actions-clip--inline">
                  <div className="message-copy-actions flex items-center gap-1">
                    {item.kind === 'text' && item.text !== null && (
                      <CopyButton label="复制文字" size="sm" onCopy={() => onCopy(item.text ?? '')} />
                    )}
                    {item.kind === 'text' && (mine || isOwner) && (
                      <IconButton icon="trash" label="删除这条内容" size="sm" tone="danger" onClick={() => onDelete(item)} />
                    )}
                  </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ol>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => {
            nearBottomRef.current = true
            scrollToBottom('smooth')
          }}
          className="anim-pop sketch-pill absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 border border-line-strong bg-raised px-4 py-2 text-sm shadow-sm"
        >
          <Icon name="arrowDown" className="size-4" />
          有 {unseen} 条新内容
        </button>
      )}
    </div>
  )
}
