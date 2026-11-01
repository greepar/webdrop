import { useId, useState } from 'react'
import { Button, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { DeviceNameEditor } from '@/features/session/DeviceNameEditor'
import type { RecoverableRoom } from '@/features/entry/use-entry'
import type { RoomCapacity } from '@/shared/types/domain'

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
export function PendingJoin({ code, expiresAt, cancelling, error, onCancel }: { code: string; expiresAt: string; cancelling: boolean; error: string | null; onCancel: () => void }) {
  return (
    <section className="anim-enter flex w-full max-w-sm flex-col items-center gap-4 text-center" aria-live="polite">
      <div className="sketch flex w-full flex-col items-center gap-3 border border-line bg-raised px-6 py-7">
        <Icon name="clock" className="size-7 text-muted" />
        <h2 className="text-lg font-semibold">等待房主同意</h2>
        <p className="text-sm leading-6 text-muted">
          已把申请发给房间 <span className="font-mono tracking-[0.15em] text-ink">{code}</span>，同意后会自动进入。
        </p>
        <p className="text-xs text-muted">申请在 {formatExpiry(expiresAt)}有效</p>
        {error && <p className="anim-fade text-sm text-danger" role="alert">{error}</p>}
        <Button variant="ghost" onClick={onCancel} disabled={cancelling} busy={cancelling} className="mt-1 min-h-10 px-4 text-sm">取消申请</Button>
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

// Public room counts for the home page: active rooms vs the configured ceiling.
// Snapshot only (no reservation); hidden while loading or on any fetch failure.
export function RoomCapacityLine({ capacity, owned }: { capacity: RoomCapacity | null; owned: number }) {
  if (!capacity) return null
  const ownedLeft = Math.max(0, capacity.maxOwnedRooms - owned)
  return (
    <p className="anim-fade mt-4 text-center text-xs leading-5 text-muted" role="status">
      当前 {capacity.activeRooms} / {capacity.maxRooms} 个房间
      {capacity.availableRooms <= 0 ? ' · 已满' : ` · 还可创建 ${capacity.availableRooms} 个`}
      {owned > 0 && ` · 我拥有 ${owned} 个，还可拥有 ${ownedLeft} 个`}
    </p>
  )
}

// Current device identity on the home page: shows the server-stored name with a rename affordance.
// Hidden until the session resolves so no placeholder name ever flashes.
export function DeviceIdentity({ name, onRename }: { name: string | null; onRename: (name: string) => Promise<{ ok: boolean; message?: string }> }) {
  if (!name) return null
  return (
    <p aria-label="当前设备" className="anim-fade mt-4 flex min-w-0 items-center justify-center gap-1 text-xs text-muted">
      <span className="max-w-64 truncate" title={name}>{name}</span>
      <DeviceNameEditor initial={name} saving={false} onSave={onRename} />
    </p>
  )
}

// Recoverable rooms come from GET /session memberships only. Opening one still revalidates the
// snapshot and membership in the room page; a stale list just keeps the shortcut visible.
export function RecoveredRooms({ rooms, stale, staleMessage, onRetry, onOpen }: {
  rooms: RecoverableRoom[]
  stale: boolean
  staleMessage: string | null
  onRetry: () => void
  onOpen: (roomId: string) => void
}) {
  if (rooms.length === 0) return null
  return (
    <section aria-label="可恢复的房间" className="anim-enter mt-6 flex w-full max-w-xs flex-col gap-3 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">继续进入</h2>
        <span className="text-xs text-muted">{rooms.length} 个房间</span>
      </div>
      {stale && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted" role="status">
          <span>{staleMessage ?? '连接不稳定，显示的是上次可用的房间'}</span>
          <Button variant="ghost" onClick={onRetry} className="min-h-9 px-2 text-xs">刷新</Button>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {rooms.map((room) => (
          <li key={room.roomId}>
            <button
              type="button"
              onClick={() => onOpen(room.roomId)}
              className="sketch flex min-h-12 w-full items-center justify-between gap-3 border border-line bg-raised px-4 py-2 text-left transition-[background-color,border-color,transform] duration-150 ease-out hover:border-line-strong active:scale-[0.99] motion-reduce:active:scale-100"
            >
              <span className="min-w-0">
                <span className="block font-mono text-sm font-semibold tracking-[0.15em] text-ink">{room.code}</span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {room.role === 'owner' ? '房主' : '成员'}
                  {room.locked ? ' · 已锁定' : ''}
                  {room.hasPassword ? ' · 有密码' : ''}
                  {room.approvalRequired ? ' · 需审批' : ''}
                </span>
              </span>
              <Icon name="arrowLeft" className="size-4 shrink-0 rotate-180 text-muted" />
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-5 text-muted">返回首页不会离开房间；进入时会重新验证权限，失效房间会自动消失。</p>
    </section>
  )
}
