import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/ui/Icon'

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <span
      className={`anim-spin inline-block rounded-full border-2 border-current border-r-transparent ${className}`}
      aria-hidden="true"
    />
  )
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName
  label: string
  tone?: 'default' | 'primary' | 'danger'
  size?: 'md' | 'sm' | 'lg' | 'responsive'
}

// Every icon-only control must have a label; it becomes the accessible name and tooltip.
export function IconButton({ icon, label, tone = 'default', size = 'md', className = '', ...props }: IconButtonProps) {
  const toneClass = {
    default: 'border-line text-ink hover:border-line-strong hover:bg-surface',
    // A disabled primary control falls back to a neutral outline instead of a dimmed filled slab.
    primary: 'border-accent bg-accent text-accent-ink hover:opacity-90 disabled:border-line disabled:bg-surface disabled:text-muted',
    danger: 'border-line text-danger hover:border-danger hover:bg-danger-soft',
  }[tone]
  const sizeClass = { sm: 'size-9', md: 'size-11', lg: 'size-14', responsive: 'size-12 sm:size-14' }[size]
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`sketch grid shrink-0 place-items-center border transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:active:scale-100 ${sizeClass} ${toneClass} ${className}`}
      {...props}
    >
      <Icon name={icon} className="size-5" />
    </button>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  busy?: boolean
}

export function Button({ variant = 'secondary', busy = false, className = '', disabled, children, ...props }: ButtonProps) {
  const variantClass = {
    primary: 'border-accent bg-accent text-accent-ink hover:opacity-90 disabled:border-line disabled:bg-surface disabled:text-muted',
    secondary: 'border-line bg-raised text-ink hover:border-line-strong',
    ghost: 'border-transparent bg-transparent text-muted hover:text-ink hover:bg-surface',
    danger: 'border-danger bg-transparent text-danger hover:bg-danger-soft',
  }[variant]
  return (
    <button
      type="button"
      className={`sketch-pill inline-flex min-h-11 items-center justify-center gap-2 border px-5 text-sm font-medium transition-[background-color,border-color,color,opacity,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100 ${variantClass} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  )
}

// Reports polite status for screen readers and a short visible line; renders nothing when empty.
export function StatusLine({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success'; children: ReactNode }) {
  if (!children) return null
  const toneClass = {
    info: 'text-muted',
    error: 'text-danger',
    success: 'text-success',
  }[tone]
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`anim-fade text-sm leading-6 ${toneClass}`}>
      {children}
    </p>
  )
}

let dialogLocks = 0
let previousBodyOverflow = ''

// Bottom sheet on small screens, centered dialog on larger ones. Closes on Escape and restores focus.
export function Dialog({ open, title, onClose, children, expanded = false, lightbox = false }: { lightbox?: boolean; expanded?: boolean; open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const exitAnimation = useRef<Animation | null>(null)
  useEffect(() => () => {
    exitAnimation.current?.cancel()
    exitAnimation.current = null
  }, [open, title])

  const closeWithFade = () => {
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (exitAnimation.current) return
    if (!backdrop || !panel || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return }
    // Exit mirrors the entrance: the panel steps back down and settles, the scrim fades. 100ms keeps it
    // quick enough that a second click never feels blocked.
    const easing = 'cubic-bezier(0.23, 1, 0.32, 1)'
    const scrim = backdrop.animate([{ opacity: getComputedStyle(backdrop).opacity }, { opacity: 0 }], {
      duration: 100, easing, fill: 'forwards',
    })
    const sheet = panel.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(8px) scale(0.985)' },
    ], { duration: 100, easing, fill: 'forwards' })
    exitAnimation.current = scrim
    void Promise.all([scrim.finished, sheet.finished]).then(() => {
      if (exitAnimation.current !== scrim) return
      exitAnimation.current = null
      onClose()
    }).catch(() => undefined)
  }

  useEffect(() => {
    if (!open) return
    const restore = document.activeElement as HTMLElement | null
    if (dialogLocks++ === 0) {
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    panelRef.current?.focus()
    return () => {
      if (--dialogLocks === 0) document.body.style.overflow = previousBodyOverflow
      if (restore?.isConnected) restore.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role=dialog]')
      if (dialogs[dialogs.length - 1] !== panelRef.current) return
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const panel = panelRef.current
        if (!panel) return
        const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (!first || !last) { event.preventDefault(); panel.focus(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
          event.preventDefault(); first.focus()
        }
      }
    }
    const onFocus = (event: FocusEvent) => {
      const panel = panelRef.current
      const dialogs = document.querySelectorAll('[role=dialog]')
      if (panel && dialogs[dialogs.length - 1] === panel && event.target instanceof Node && !panel.contains(event.target)) panel.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div ref={backdropRef} onClickCapture={(event) => { if (exitAnimation.current) { event.preventDefault(); event.stopPropagation() } }} data-lightbox={lightbox} className="anim-fade fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6" role="presentation">
      <button type="button" aria-label="关闭" className="absolute inset-0 bg-scrim" onClick={closeWithFade} tabIndex={-1} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-lightbox={lightbox}
        data-expanded={expanded}
        className="anim-pop relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-raised shadow-[0_-8px_30px_rgb(0_0_0/0.08)] outline-none sm:max-w-md sm:rounded-3xl sm:shadow-[0_18px_50px_rgb(0_0_0/0.18)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className={lightbox ? "sr-only" : "flex items-center justify-between gap-4 border-b border-line px-5 py-4"}>
          <h2 id={titleId} className="min-w-0 break-all text-base font-semibold">{title}</h2>
          <IconButton icon="x" label="关闭" size="sm" onClick={closeWithFade} />
        </div>
        <div className={lightbox ? "min-h-0" : "min-h-0 overflow-y-auto overscroll-contain px-5 py-5"}>{children}</div>
      </div>
    </div>
  )
}

// Floating room-level toast pill. The parent provides the overlay stack positioning
// (absolute, below the top bar) so multiple toasts never fight for the same spot.
// The pill stays mounted: show only flips classes, so enter/exit always transitions.
// First-mount entry animates via @starting-style in .room-toast (no JS effect needed).
export function RoomToast({ show, tone = 'info', message, actionLabel, onAction, busy = false, onClose }: {
  show: boolean
  tone?: 'info' | 'error' | 'success'
  message: ReactNode
  actionLabel?: string
  onAction?: () => void
  busy?: boolean
  onClose?: () => void
}) {
  const toneClass = {
    info: 'text-muted',
    error: 'text-danger',
    success: 'text-success',
  }[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-hidden={!show}
      data-hidden={!show}
      className="room-toast sketch-pill pointer-events-auto flex max-w-full items-center gap-2 border border-line-strong bg-raised px-4 py-2 text-sm shadow-sm"
    >
      <span className={`min-w-0 ${toneClass}`}>{message}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {busy && show && <Spinner className="size-3.5" />}
        {actionLabel && onAction && !busy && (
          <button type="button" onClick={onAction} className="rounded-full px-2 py-1 text-xs text-muted underline hover:text-ink">
            {actionLabel}
          </button>
        )}
        {onClose && show && !busy && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭提示"
            className="grid size-7 place-items-center rounded-full text-muted transition-colors duration-150 hover:text-ink"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  )
}

export function DevMockBadge() {
  return (
    <span className="whitespace-nowrap rounded-full border border-dashed border-line-strong px-2.5 py-0.5 text-xs text-muted" title="未连接真实 API，数据仅在本页内存中">
      开发 mock
    </span>
  )
}
