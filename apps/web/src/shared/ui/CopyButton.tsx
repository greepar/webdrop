import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@/shared/ui/primitives'

type Props = {
  label: string
  size?: 'sm' | 'md' | 'lg' | 'responsive'
  tone?: 'default' | 'primary' | 'danger'
  // Resolves true on success. Only success flips the button to a check; failure stays on the
  // caller (top notice), so the button never pretends a failed copy succeeded.
  onCopy: () => Promise<boolean>
}

const DONE_MS = 2000

// Purpose: feedback for copy actions. The icon crossfades copy -> check in place; the button keeps
// its size so the row never shifts. Transitions only opacity/transform, 150ms ease-out.
export function CopyButton({ label, size = 'sm', tone = 'default', onCopy }: Props) {
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef(0)
  const busyRef = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const click = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const ok = await onCopy()
      if (ok) {
        window.clearTimeout(timer.current)
        setDone(true)
        timer.current = window.setTimeout(() => setDone(false), DONE_MS)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <span className="relative inline-flex">
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 grid place-items-center text-success transition-opacity duration-150 ease-out motion-reduce:transition-none ${done ? 'opacity-100' : 'opacity-0'}`}
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.9 12.6c2 1.8 3.7 3.6 4.9 5.2 2.4-4.5 5.1-8.6 9.6-13.2" />
        </svg>
      </span>
      <span className={`transition-opacity duration-150 ease-out motion-reduce:transition-none ${done ? 'opacity-0' : 'opacity-100'}`}>
        <IconButton
          icon="copy"
          label={done ? '已复制' : label}
          size={size}
          tone={tone}
          onClick={click}
          disabled={busy}
          aria-live="polite"
        />
      </span>
    </span>
  )
}
