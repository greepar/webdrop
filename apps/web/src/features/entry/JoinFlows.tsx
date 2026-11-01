import { useId, useState } from 'react'
import { Button, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'

// The password never leaves this form except in the join request body: no URL, no storage, no logs.
export function PasswordPrompt({ disabled, error, onSubmit, onCancel }: {
  disabled: boolean
  error: string | null
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const id = useId()
  const errorId = useId()
  return (
    <form
      className="anim-enter mt-6 flex w-full max-w-xs flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.length > 0) onSubmit(value)
      }}
    >
      <label htmlFor={id} className="text-left text-sm text-ink">房间密码</label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setValue(event.target.value)}
        className="sketch min-h-12 w-full border border-line-strong bg-raised px-4 text-center text-[16px] text-ink outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50 aria-[invalid=true]:border-danger"
        placeholder="输入密码"
      />
      <div className="flex items-center justify-center gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={disabled}>取消</Button>
        <Button type="submit" variant="primary" disabled={disabled || value.length === 0} busy={disabled}>加入</Button>
      </div>
      <StatusLine tone="error">{error}</StatusLine>
    </form>
  )
}

// Shown while the owner decides. The applicant is not a member yet, so nothing else is fetched.
export function PendingJoin({ code, expiresAt, onCancel }: { code: string; expiresAt: string; onCancel: () => void }) {
  return (
    <section className="anim-enter flex w-full max-w-sm flex-col items-center gap-4 text-center" aria-live="polite">
      <div className="sketch flex w-full flex-col items-center gap-3 border border-line bg-raised px-6 py-7">
        <Icon name="clock" className="size-7 text-muted" />
        <h2 className="text-lg font-semibold">等待房主同意</h2>
        <p className="text-sm leading-6 text-muted">
          已把申请发给房间 <span className="font-mono tracking-[0.15em] text-ink">{code}</span>，同意后会自动进入。
        </p>
        <p className="text-xs text-muted">申请在 {formatExpiry(expiresAt)}有效</p>
        <Button variant="ghost" onClick={onCancel} className="mt-1 min-h-10 px-4 text-sm">取消申请</Button>
      </div>
    </section>
  )
}

function formatExpiry(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '10 分钟内'
  const minutes = Math.ceil((date.getTime() - Date.now()) / 60_000)
  if (minutes <= 0) return '已过期'
  return `${minutes} 分钟内`
}

// Creating is offered only for a code that could not be joined. Both settings are optional.
export function CreateRoomPanel({ disabled, password, approvalRequired, onPassword, onApproval, onCreate, onCancel }: {
  disabled: boolean
  password: string
  approvalRequired: boolean
  onPassword: (value: string) => void
  onApproval: (value: boolean) => void
  onCreate: () => void
  onCancel: () => void
}) {
  const id = useId()
  const bytes = new TextEncoder().encode(password).length
  const tooLong = bytes > 72
  return (
    <form
      className="anim-enter mt-6 flex w-full max-w-xs flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault()
        if (!tooLong) onCreate()
      }}
    >
      <label htmlFor={id} className="text-sm text-muted">房间密码（可选）</label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        value={password}
        disabled={disabled}
        onChange={(event) => onPassword(event.target.value)}
        aria-describedby={`${id}-hint`}
        className="sketch min-h-12 w-full border border-line-strong bg-raised px-4 text-center text-[16px] text-ink outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50 aria-[invalid=true]:border-danger"
        placeholder="不填则无需密码"
        aria-invalid={tooLong || undefined}
      />
      <p id={`${id}-hint`} className={`text-xs ${tooLong ? 'text-danger' : 'text-muted'}`}>
        {tooLong ? '密码超过 72 字节' : '1–72 字节，空格和大小写都算数'}
      </p>
      <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
        <input
          type="checkbox"
          checked={approvalRequired}
          disabled={disabled}
          onChange={(event) => onApproval(event.target.checked)}
          className="size-5 accent-[var(--c-accent)]"
        />
        需要房主同意才能加入
      </label>
      <div className="mt-1 flex items-center justify-center gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={disabled}>取消</Button>
        <Button type="submit" variant="primary" disabled={disabled || tooLong} busy={disabled}>创建</Button>
      </div>
    </form>
  )
}
