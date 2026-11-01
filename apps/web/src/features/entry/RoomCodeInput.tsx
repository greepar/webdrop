import { useId, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { IconButton } from '@/shared/ui/primitives'

type Props = {
  value: string
  length: number
  disabled: boolean
  error: string | null
  onChange: (value: string) => void
  onRandom: () => void
  onCreate: () => void
  onJoin: () => void
}

// Text input (not type=number) so leading zeros survive; numeric keypad via inputMode.
export function RoomCodeInput({ value, length, disabled, error, onChange, onRandom, onCreate, onJoin }: Props) {
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const sanitize = (raw: string) => raw.replace(/\D/g, '').slice(0, length)

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    const digits = sanitize(text)
    if (!digits) return
    event.preventDefault()
    onChange(digits)
  }

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (value.length === length) onJoin()
    }
  }

  const complete = value.length === length

  return (
    <div className="w-full max-w-sm">
      <label htmlFor={inputId} className="sr-only">房间号（{length} 位数字）</label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={length}
          placeholder={'0'.repeat(length)}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(sanitize(event.target.value))}
          onPaste={handlePaste}
          onKeyDown={handleKey}
          className="sketch min-h-14 min-w-0 flex-1 border border-line-strong bg-raised px-5 text-center font-mono text-[22px] tracking-[0.3em] text-ink outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50 aria-[invalid=true]:border-danger"
        />
        <IconButton icon="shuffle" label="随机创建房间" onClick={onRandom} disabled={disabled} size="lg" />
        <IconButton
          icon="plus"
          label={complete ? `用 ${value} 创建房间` : '创建房间（输入房间号）'}
          tone="primary"
          onClick={onCreate}
          disabled={disabled || !complete}
          size="lg"
        />
      </div>
      <div className="mt-3 flex min-h-6 items-center justify-between gap-3 text-sm">
        {error ? <p id={errorId} role="alert" className="anim-fade text-danger">{error}</p> : <span />}
        <button
          type="button"
          onClick={onJoin}
          disabled={disabled || !complete}
          className="rounded-full px-3 py-1 text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          加入已有房间
        </button>
      </div>
    </div>
  )
}
