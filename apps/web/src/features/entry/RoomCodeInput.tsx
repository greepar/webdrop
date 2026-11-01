import { useEffect, useId, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { IconButton } from '@/shared/ui/primitives'

type Props = {
  value: string
  length: number
  disabled: boolean
  error: string | null
  hint?: string | null
  // Creating is offered only after the code turned out not to be joinable.
  canCreate: boolean
  onChange: (value: string) => void
  onCreate: () => void
  onRandom: () => void
}

// One box per digit. Filling the last box joins automatically; the button below creates a room with
// the entered code instead. Digits stay strings so leading zeros survive.
export function RoomCodeInput({ value, length, disabled, error, hint, canCreate, onChange, onCreate, onRandom }: Props) {
  const errorId = useId()
  const boxes = useRef<Array<HTMLInputElement | null>>([])
  const digits = toDigits(value, length)

  // The boxes are positional, so a parent value that no longer matches the visible digits (for
  // example after the page clears the code) is normalised back to a contiguous run.
  useEffect(() => {
    const normalised = toDigits(value, length).join('')
    if (value !== normalised) onChange(normalised)
  }, [value, length, onChange])

  const focusBox = (index: number) => {
    const target = boxes.current[Math.max(0, Math.min(index, length - 1))]
    target?.focus()
    target?.select()
  }

  const write = (next: string[]) => {
    onChange(next.join(''))
  }

  const setDigit = (index: number, digit: string) => {
    const next = [...digits]
    next[index] = digit
    write(next)
    if (digit) focusBox(index + 1)
  }

  const onInput = (index: number, raw: string) => {
    const cleaned = raw.replace(/\D/g, '')
    if (!cleaned) {
      setDigit(index, '')
      return
    }
    // Typing over a filled box replaces it; a pasted run spreads across the remaining boxes.
    if (cleaned.length > 1) {
      fill(cleaned, index)
      return
    }
    setDigit(index, cleaned)
  }

  const fill = (text: string, start = 0) => {
    const next = [...digits]
    const chars = text.replace(/\D/g, '').slice(0, length - start).split('')
    chars.forEach((char, offset) => {
      next[start + offset] = char
    })
    write(next)
    focusBox(start + chars.length)
  }

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        setDigit(index, '')
        focusBox(index)
      } else {
        const previous = Math.max(0, index - 1)
        const next = [...digits]
        next[previous] = ''
        write(next)
        focusBox(previous)
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusBox(index - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusBox(index + 1)
      return
    }
    if (event.key === 'Enter') {
      // Joining is automatic once all boxes are filled; Enter only matters for the create offer.
      event.preventDefault()
    }
  }

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text').replace(/\D/g, '')
    if (!text) return
    event.preventDefault()
    fill(text, index)
  }

  const complete = digits.every(Boolean)

  return (
    <div className="flex w-full flex-col items-center">
      <div className="flex items-center gap-2 sm:gap-2.5">
      <div role="group" aria-label={`房间号，${length} 位数字`} aria-describedby={error ? errorId : undefined} className="flex items-center gap-2 sm:gap-2.5">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(element) => { boxes.current[index] = element }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            autoCapitalize="off"
            spellCheck={false}
            maxLength={1}
            value={digit}
            disabled={disabled}
            aria-label={`第 ${index + 1} 位`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onInput(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
            onFocus={(event) => event.target.select()}
            className="sketch size-12 border border-line-strong bg-raised text-center font-mono text-[20px] leading-none text-ink caret-transparent outline-none transition-[border-color,box-shadow] duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50 aria-[invalid=true]:border-danger sm:size-16 sm:text-[26px]"
          />
        ))}
      </div>
        <IconButton
          icon="shuffle"
          label="随机创建房间"
          onClick={onRandom}
          disabled={disabled}
          size="responsive"
        />
      </div>

      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          disabled={disabled || !complete}
          data-create-room
          className="sketch-pill anim-enter mt-6 inline-flex min-h-11 items-center gap-2 border border-line-strong bg-raised px-5 text-sm font-medium text-ink transition-[background-color,border-color,color,transform] duration-150 ease-out hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:border-line disabled:text-muted motion-reduce:active:scale-100"
        >
          <span aria-hidden="true" className="text-lg leading-none">+</span>
          创建房间
        </button>
      )}

      <div className="mt-4 min-h-6 px-2 text-center text-sm">
        {error
          ? <p id={errorId} role="alert" className="anim-fade text-danger">{error}</p>
          : hint ? <p role="status" className="anim-fade text-muted">{hint}</p> : null}
      </div>
    </div>
  )
}

function toDigits(value: string, length: number) {
  const chars = value.replace(/\D/g, '').split('')
  return Array.from({ length }, (_, index) => chars[index] ?? '')
}
