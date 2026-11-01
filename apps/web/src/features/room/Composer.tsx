import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { VoiceRecorder } from './VoiceRecorder'
import { formatBytes } from './format'
import { readClipboardFiles, readClipboardText } from '@/shared/clipboard'
import { Button, IconButton, StatusLine } from '@/shared/ui/primitives'

type Props = {
  maxFileBytes?: number
  disabled: boolean
  onSend: (text: string) => Promise<boolean>
  onPickFiles: (files: File[]) => void
}

// The composer keeps newlines and IME composition: Enter sends only outside composition and without Shift.
export function Composer({ disabled, onSend, onPickFiles, maxFileBytes }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const pastePending = useRef(false)
  const [pasting, setPasting] = useState(false)
  const [pasteNotice, setPasteNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    const draft = text
    if (!draft.trim() || pending.current || disabled) return
    pending.current = true
    setSending(true)
    try {
      const ok = await onSend(draft)
      if (ok) setText((current) => current === draft ? '' : current)
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  const paste = async () => {
    if (disabled || pastePending.current) return
    const area = areaRef.current
    const initial = text
    const start = area?.selectionStart ?? text.length
    const end = area?.selectionEnd ?? start
    pastePending.current = true
    setPasting(true)
    setPasteNotice(null)
    // Files first: screenshots / copied images land as files, not text. Allowed types still go
    // through the room's normal upload path (size + permission checks in onPickFiles).
    const files = await readClipboardFiles()
    if (files.length > 0) {
      pastePending.current = false
      if (!mounted.current) return
      setPasting(false)
      onPickFiles(files)
      return
    }
    const value = await readClipboardText()
    pastePending.current = false
    if (!mounted.current) return
    setPasting(false)
    if (value === null) { setPasteNotice('无法读取剪贴板，请在输入框中手动粘贴'); return }
    if (!value) { setPasteNotice('剪贴板里没有内容'); return }
    setText(current => current === initial ? current.slice(0, start) + value + current.slice(end) : current + value)
    const unchanged = areaRef.current?.value === initial
    areaRef.current?.focus()
    requestAnimationFrame(() => {
      const current = areaRef.current
      if (current) { const caret = unchanged ? start + value.length : current.value.length; current.setSelectionRange(caret, caret) }
    })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <form onSubmit={onSubmit} className="relative border-t border-line bg-canvas/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{maxFileBytes !== undefined ? `单个文件不超过 ${formatBytes(maxFileBytes)}` : ''}</p>
        <Button variant="ghost" onClick={paste} disabled={disabled || pasting} className="min-h-11 shrink-0 px-3 text-xs">{pasting ? '正在读取…' : '粘贴'}</Button>
      </div>
      {pasteNotice && <div className="mb-2"><StatusLine tone="error">{pasteNotice}</StatusLine></div>}
      <div className="flex items-end gap-2">
        <IconButton icon="paperclip" label="选择文件" onClick={() => fileRef.current?.click()} disabled={disabled} className="size-11" />
        <VoiceRecorder disabled={disabled} onSend={onPickFiles} />
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length) onPickFiles(files)
          }}
        />
        <label className="flex min-w-0 flex-1 flex-col">
          <span className="sr-only">输入文字，Enter 发送，Shift+Enter 换行</span>
          <textarea
            ref={areaRef}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              // Let the browser paste natively, including images delivered as files.
              const files = Array.from(event.clipboardData.files)
              if (files.length) {
                event.preventDefault()
                onPickFiles(files)
              }
            }}
            placeholder="输入文字…"
            className="sketch max-h-40 min-h-11 w-full resize-none border border-line-strong bg-raised px-4 py-2.5 text-[16px] leading-6 text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50"
            style={{ fieldSizing: 'content' } as CSSProperties}
          />
        </label>
        <IconButton
          icon="send"
          label="发送"
          tone="primary"
          type="submit"
          disabled={disabled || sending || text.trim().length === 0}
          className="size-11"
        />
      </div>
    </form>
  )
}
