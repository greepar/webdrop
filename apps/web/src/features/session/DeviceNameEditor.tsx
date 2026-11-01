import { useEffect, useState } from 'react'
import { Button } from '@/shared/ui/primitives'
import { deviceNameError } from '@/features/session/device-name'

// Inline rename for the current device name. Idle state is just a pencil button for the
// parent row's right side; the name itself stays in the row's text. Editing expands to a
// full-width input row. Pessimistic: the server value wins on save.
export function DeviceNameEditor({ initial, saving, onSave }: {
  initial: string
  saving: boolean
  onSave: (name: string) => Promise<{ ok: boolean; message?: string }>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (!editing) setDraft(initial) }, [editing, initial])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(initial); setError(null); setEditing(true) }}
        aria-label={`改名，当前 ${initial}`}
        title="改名"
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.5 5.5 18.5 9.5 8.5 19.5 4 20.5 3.5 16 13.5 6Z M13 7l4 4" />
        </svg>
      </button>
    )
  }

  const invalid = deviceNameError(draft)
  const save = async () => {
    if (invalid || saving) {
      setError(invalid)
      return
    }
    const result = await onSave(draft.trim())
    if (result.ok) setEditing(false)
    else setError(result.message ?? '改名未成功，请重试')
  }

  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={draft}
          disabled={saving}
          maxLength={40}
          onChange={(event) => { setDraft(event.target.value); setError(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') setEditing(false)
          }}
          aria-label="设备名"
          placeholder={initial}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-raised px-2 text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50"
        />
        <Button variant="primary" disabled={saving || !!invalid} busy={saving} onClick={() => void save()} className="min-h-9 shrink-0 px-3 text-xs">保存</Button>
        <Button variant="ghost" disabled={saving} onClick={() => setEditing(false)} className="min-h-9 shrink-0 px-2 text-xs">取消</Button>
      </span>
      {(error ?? (invalid && draft !== initial ? invalid : null)) && (
        <span className="anim-fade text-xs text-danger" role="alert">{error ?? invalid}</span>
      )}
    </span>
  )
}
