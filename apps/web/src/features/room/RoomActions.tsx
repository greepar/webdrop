import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, IconButton, Spinner, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { closeRoom, fetchRoomSnapshot, fetchSession, leaveRoom, listJoinRequests, removeMember, rotateRoomCode, updateRoomSettings } from '@/features/room/api'
import { isApiError } from '@/shared/api/errors'
import { notifySessionChanged, useSession } from '@/features/session/use-session'
import { DeviceNameEditor } from '@/features/session/DeviceNameEditor'
import { JoinRequests } from '@/features/room/JoinRequests'
import type { Member, Room } from '@/shared/types/domain'

type Props = {
  room: Room
  members: Member[]
  selfMemberId: string
  isOwner: boolean
  // Bumped by useRoom on every join-request SSE arrival. The badge refreshes on this signal;
  // the count itself always comes from the list API, never from the event payload.
  joinRequestTick?: number
  onChanged: () => void
  onLeft: () => void
  onOpenFiles?: () => void
}

type PendingKind =
  | 'policy'
  | 'approval'
  | 'password'
  | 'rotate'
  | 'moderation'
  | null

// Owner-only controls follow the caller's membership role from the session. The server still
// checks every call; hiding a button is never the authorization.
export function RoomActions({ room, members, selfMemberId, isOwner, joinRequestTick = 0, onChanged, onLeft, onOpenFiles }: Props) {
  const [open, setOpen] = useState<'members' | 'manage' | null>(null)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [pending, setPending] = useState<PendingKind>(null)
  // Per-rule save state stays separate from the description text: the description never rewrites
  // on toggle, only this small slot shows saving / failure without moving layout.
  const [ruleError, setRuleError] = useState<{ key: 'policy' | 'password' | 'approval'; text: string } | null>(null)
  // Synchronous guard so a double click cannot send the same owner action twice.
  const busyRef = useRef(false)
  // One in-flight save per rule; a second tap on the same switch is ignored, other switches stay usable.
  const ruleBusyRef = useRef<{ policy: boolean; approval: boolean; password: boolean }>({ policy: false, approval: false, password: false })
  const [confirm, setConfirm] = useState<null | { kind: 'close' | 'leave' | 'kick'; memberId?: string }>(null)
  // Direction of the in-dialog step change, so forward and back animate opposite ways.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  // Password field is a draft until saved: empty means "leave the password as it is".
  const [passwordDraft, setPasswordDraft] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Expanded when the owner turns the password switch on without a saved password yet.
  const [passwordOpen, setPasswordOpen] = useState(false)
  // Join-request freshness: SSE wakes us instantly; interval refresh covers streams the
  // backend does not emit yet (or a missed event). Either path re-reads the list and the badge
  // follows the list, never the event payload. Paused while hidden.
  const [watchedCount, setWatchedCount] = useState<number | null>(null)
  const [toastDismissedFor, setToastDismissedFor] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const sessionRename = useSession().rename
  const owner = isOwner
  const locked = room.joinPolicy === 'locked'

  useEffect(() => {
    if (!owner || !room.approvalRequired) {
      setWatchedCount(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    const refresh = async () => {
      try {
        const list = await listJoinRequests(room.id, controller.signal)
        if (!cancelled) setWatchedCount(list.length)
      } catch {
        // Keep the last count; the next tick or event retries.
      }
    }
    // Slow safety net only (SSE is the fast path). 30s keeps the failure mode bounded
    // without adding per-room polling load once the backend emits events.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    void refresh()
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // joinRequestTick: every SSE arrival re-reads the list immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, room.approvalRequired, room.id, joinRequestTick])

  // Panel reads and SSE refreshes update the same count; a closed panel must not pin an old value.
  const badgeCount = watchedCount
  const showArrivalToast = owner && room.approvalRequired && (badgeCount ?? 0) > 0 && open !== 'manage' && toastDismissedFor !== badgeCount

  // Stable copy: the description never rewrites on toggle. The switch expresses the state;
  // the slot below only reports saving / failure without moving text around it.
  const savingPolicy = pending === 'policy'
  const savingApproval = pending === 'approval'
  const savingPassword = pending === 'password'
  const passwordOn = room.hasPassword || passwordOpen

  const ask = (next: { kind: 'close' | 'leave' | 'kick'; memberId?: string }) => {
    setDirection('forward')
    setConfirm(next)
  }

  // A destructive confirmation should not leave focus on the trigger that just disappeared.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      if (confirm) document.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus()
      else contentRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [confirm, open])

  // Pessimistic switches: no optimistic flip, no remount. The saved server value drives
  // aria-checked; while saving only the rule's inline status slot changes.
  // Leave/close only navigate after 204; on timeout/5xx the response may be lost, so re-read the
  // session and snapshot before deciding instead of assuming success or failure.
  const runRule = async (key: 'policy' | 'approval' | 'password', patch: () => Promise<unknown>) => {
    if (ruleBusyRef.current[key]) return
    ruleBusyRef.current[key] = true
    setPending(key)
    setRuleError(null)
    setNotice(null)
    try {
      await patch()
      // Rule switches report success by position alone; no bottom notice, so the dialog never
      // grows and recenters on every toggle. Failures still surface inline + top notice.
      onChanged()
    } catch (error) {
      // Rule failures stay inline only (the slot announces via role=alert): no bottom notice, so
      // the dialog never grows on toggle outcomes. Permission loss still refreshes from server.
      if (isApiError(error) && (error.code === 'OWNER_REQUIRED' || error.code === 'FORBIDDEN')) {
        setRuleError({ key, text: '已没有管理权限' })
        onChanged()
        return
      }
      setRuleError({ key, text: describeActionError(error) })
    } finally {
      ruleBusyRef.current[key] = false
      setPending(null)
    }
  }

  const run = async (kind: Exclude<PendingKind, null>, action: () => Promise<unknown>, success: string, after?: () => void, verifyGone?: boolean) => {
    if (busyRef.current) return
    busyRef.current = true
    setPending(kind)
    setNotice(null)
    if (kind === 'policy' || kind === 'approval' || kind === 'password') setRuleError(null)
    try {
      await action()
      setNotice({ tone: 'success', text: success })
      if (after) after()
      else onChanged()
    } catch (error) {
      if (verifyGone && isApiError(error) && (error.status === 0 || error.status >= 500)) {
        const verified = await reverifyMembership(room.id)
        if (verified === 'gone') {
          notifySessionChanged()
          if (after) after()
          else onChanged()
          return
        }
        if (verified === 'stay') {
          setNotice({ tone: 'error', text: '操作未成功，请重试' })
          return
        }
      }
      if (isApiError(error) && (error.code === 'OWNER_REQUIRED' || error.code === 'FORBIDDEN')) {
        setNotice({ tone: 'error', text: '已没有管理权限' })
        onChanged()
        return
      }
      if (isApiError(error) && error.code === 'OWNER_MUST_CLOSE') {
        setNotice({ tone: 'error', text: '房主不能直接离开，请先关闭房间' })
        return
      }
      if (isApiError(error) && error.status === 404) {
        // Already gone (closed, removed or repeated request): converge to the server state instead
        // of keeping a dead entry.
        notifySessionChanged()
        if (after) after()
        else onChanged()
        return
      }
      setNotice({ tone: 'error', text: describeActionError(error) })
    } finally {
      busyRef.current = false
      setPending(null)
    }
  }

  const onConfirm = async () => {
    if (!confirm) return
    const current = confirm
    if (current.kind === 'close') {
      await run('moderation', () => closeRoom(room.id), '房间已关闭', () => onLeft(), true)
    } else if (current.kind === 'leave') {
      await run('moderation', () => leaveRoom(room.id), '已离开房间', () => onLeft(), true)
    } else if (current.memberId) {
      const memberId = current.memberId
      await run('moderation', () => removeMember(room.id, memberId), '已移出成员')
    }
    setConfirm(null)
  }

  // One modal at a time: a confirmation replaces the panel's body and title instead of stacking a
  // second dialog over the first.
  const closePanel = () => {
    setConfirm(null)
    setOpen(null)
    setRuleError(null)
    setPasswordDraft('')
    setPasswordError(null)
    setPasswordOpen(false)
  }

  const passwordBytes = new TextEncoder().encode(passwordDraft).length

  const togglePassword = () => {
    if (ruleBusyRef.current.password) return
    if (room.hasPassword) {
      void runRule('password', () => updateRoomSettings(room.id, { password: null }))
      return
    }
    // No saved password yet: the switch only expands the form, no request is sent.
    // Turning it back off discards the draft.
    if (passwordOpen) {
      setPasswordOpen(false)
      setPasswordDraft('')
      setPasswordError(null)
    } else {
      setPasswordOpen(true)
    }
  }

  const savePassword = () => {
    if (passwordBytes === 0 || passwordBytes > 72 || ruleBusyRef.current.password) return
    void runRule('password', () => updateRoomSettings(room.id, { password: passwordDraft }))
  }

  const setPolicy = (next: 'open' | 'locked') => {
    if (next === room.joinPolicy) return
    void runRule('policy', () => updateRoomSettings(room.id, { joinPolicy: next }))
  }

  const setApproval = (required: boolean) => {
    if (required === room.approvalRequired) return
    void runRule('approval', () => updateRoomSettings(room.id, { approvalRequired: required }))
  }
  const backFromConfirm = () => {
    setDirection('back')
    setConfirm(null)
  }

  return (
    <>
      {showArrivalToast && (
        <div className="anim-pop fixed inset-x-0 top-16 z-30 flex justify-center px-4 sm:top-20" role="status">
          <div className="sketch-pill flex items-center gap-2 border border-line-strong bg-raised py-2 pr-2 pl-4 text-sm shadow-sm">
            <Icon name="users" className="size-4 text-muted" />
            <span>有 {badgeCount} 条入房申请待处理</span>
            <Button
              variant="primary"
              onClick={() => setOpen('manage')}
              className="min-h-9 px-3 text-xs"
            >
              去处理
            </Button>
            <button
              type="button"
              aria-label="忽略这次提醒"
              onClick={() => setToastDismissedFor(badgeCount ?? 0)}
              className="grid size-9 place-items-center rounded-full text-muted transition-colors duration-150 hover:text-ink"
            >
              <Icon name="x" className="size-4" />
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 sm:hidden">
          <IconButton icon="users" label={`成员，${members.length} 人`} onClick={() => setOpen('members')} />
          {onOpenFiles && <IconButton icon="file" label="文件列表" onClick={onOpenFiles} />}
          {owner && (
            <span className="relative">
              <IconButton icon="more" label={badgeCount ? `房间设置，有 ${badgeCount} 条入房申请待处理` : '房间设置'} onClick={() => setOpen('manage')} />
              {badgeCount ? (
                <span aria-hidden="true" className="absolute -top-1 -right-1 grid min-size-5 size-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
                  {badgeCount > 9 ? '9+' : badgeCount}
                </span>
              ) : null}
            </span>
          )}
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <Button variant="secondary" onClick={() => setOpen('members')} className="min-h-10 px-4 text-sm">
            <Icon name="users" className="size-4" />
            成员 {members.length}
          </Button>
          {onOpenFiles && (
            <Button variant="secondary" onClick={onOpenFiles} className="min-h-10 px-4 text-sm">
              <Icon name="file" className="size-4" />
              文件
            </Button>
          )}
          {owner && (
            <Button variant="secondary" onClick={() => setOpen('manage')} className="relative min-h-10 px-4 text-sm">
              <Icon name="more" className="size-4" />
              管理
              {badgeCount ? (
                <span aria-hidden="true" className="absolute -top-1.5 -right-1.5 grid min-size-5 size-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
                  {badgeCount > 9 ? '9+' : badgeCount}
                </span>
              ) : null}
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={open === 'members'}
        title={<span key={confirm ? 'c' : 'm'} className="anim-title">{confirm ? confirmTitle(confirm.kind) : '成员'}</span>}
        onClose={closePanel}
      >
        {confirm ? (
          <div key="confirm" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
            <ConfirmPanel body={confirmBody(confirm.kind)} busy={pending === 'moderation'} onCancel={backFromConfirm} onConfirm={onConfirm} />
          </div>
        ) : (
        <div key="list" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
        <ul className="flex flex-col gap-2.5">
          {members.map((member) => (
            <li key={member.id} className={`sketch flex items-center justify-between gap-3 border border-line bg-raised px-3.5 py-2.5 ${member.id === selfMemberId ? 'flex-wrap' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{member.displayName}{member.id === selfMemberId && '（我）'}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {member.role === 'owner' ? '房主' : '成员'} · <span aria-label={member.presence === 'online' ? '在线' : '离线'}>{member.presence === 'online' ? '在线' : '离线'}</span>
                </p>
              </div>
              {member.id === selfMemberId ? (
                <DeviceNameEditor initial={member.displayName} saving={false} onSave={sessionRename} />
              ) : owner && member.role !== 'owner' ? (
                <Button variant="ghost" onClick={() => ask({ kind: 'kick', memberId: member.id })} disabled={pending !== null} className="min-h-9 shrink-0 px-3 text-xs text-danger">
                  移出
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {!owner && (
          <div className="mt-5 border-t border-line pt-5">
            <Button variant="danger" onClick={() => ask({ kind: 'leave' })} className="w-full">离开房间</Button>
          </div>
        )}
        {notice && <div className="mt-3"><StatusLine tone={notice?.tone === 'error' ? 'error' : 'success'}>{notice?.text}</StatusLine></div>}
        </div>
        )}
      </Dialog>

      <Dialog
        open={open === 'manage'}
        title={<span key={confirm ? 'c' : 's'} className="anim-title">{confirm ? confirmTitle(confirm.kind) : '房间设置'}</span>}
        onClose={closePanel}
      >
        {confirm ? (
          <div key="confirm" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
            <ConfirmPanel body={confirmBody(confirm.kind)} busy={pending === 'moderation'} onCancel={backFromConfirm} onConfirm={onConfirm} />
          </div>
        ) : (
        <div key="settings" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
        <div className="flex flex-col gap-5">
          <section aria-label="入房规则">
            <p className="text-sm font-medium">入房规则</p>
            <p className="mt-1 text-xs leading-5 text-muted">新成员加入时的门槛，密码和审批可以同时开启。已有成员不受影响。</p>
            <div className="mt-3 flex flex-col gap-4">
              <RuleRow
                title="允许新成员加入"
                description="关闭后阻止新成员加入，已有成员不受影响。"
                switchLabel="允许新成员加入"
                checked={!locked}
                saving={savingPolicy}
                saveText="保存中…"
                error={ruleError?.key === 'policy' ? ruleError.text : null}
                onChange={() => setPolicy(locked ? 'open' : 'locked')}
              />
              <div className="border-t border-line pt-4">
                <RuleRow
                  title="房间密码"
                  description="新成员加入时需验证密码，可与审批同时使用。"
                  switchLabel="房间密码"
                  checked={passwordOn}
                  saving={savingPassword}
                  saveText={room.hasPassword ? '取消中…' : '保存中…'}
                  error={ruleError?.key === 'password' ? ruleError.text : null}
                  onChange={togglePassword}
                />
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${passwordOn ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                  aria-hidden={!passwordOn}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="pt-3">
                      <label htmlFor="room-password" className="sr-only">房间密码</label>
                      <input
                        id="room-password"
                        type="password"
                        autoComplete="new-password"
                        value={passwordDraft}
                        disabled={savingPassword}
                        tabIndex={passwordOn ? 0 : -1}
                        onChange={(event) => {
                          const next = event.target.value
                          setPasswordDraft(next)
                          setPasswordError(new TextEncoder().encode(next).length > 72 ? '密码超过 72 字节' : null)
                        }}
                        placeholder={room.hasPassword ? '输入新密码以更换' : '设置密码'}
                        aria-describedby="room-password-hint"
                        className="sketch min-h-11 w-full border border-line-strong bg-raised px-3 text-[16px] text-ink outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--c-accent-soft)] disabled:opacity-50"
                      />
                      <p id="room-password-hint" className={`mt-1 text-xs leading-5 ${passwordError ? 'text-danger' : 'text-muted'}`}>
                        {passwordError ?? '1–72 字节，空格和大小写都算数'}
                      </p>
                      <div className="mt-2">
                        <Button
                          variant="secondary"
                          disabled={savingPassword || passwordBytes === 0 || passwordBytes > 72}
                          busy={savingPassword}
                          onClick={savePassword}
                          className="w-full"
                        >
                          {room.hasPassword ? '更换密码' : '设置密码'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="border-t border-line pt-4">
                <RuleRow
                  title="需要管理员同意"
                  description="新成员需经管理员批准后才能进入。"
                  switchLabel="需要管理员同意"
                  checked={room.approvalRequired}
                  saving={savingApproval}
                  saveText="保存中…"
                  error={ruleError?.key === 'approval' ? ruleError.text : null}
                  onChange={() => setApproval(!room.approvalRequired)}
                />
              </div>
            </div>
          </section>
          {room.approvalRequired && (
            <div className="border-t border-line pt-5">
              <div className="flex min-h-6 items-center justify-between gap-2">
                <p className="text-sm font-medium">入房申请</p>
                {watchedCount !== null && watchedCount > 0 && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-ink">{watchedCount} 条待处理</span>
                )}
              </div>
              <div className="mt-3"><JoinRequests roomId={room.id} joinRequestTick={joinRequestTick} onCount={setWatchedCount} /></div>
            </div>
          )}
          <div>
            <p className="text-sm font-medium">更换房间号</p>
            <p className="mt-1 min-h-5 text-xs leading-5 text-muted">原房间号会立即失效。</p>
            <Button variant="secondary" disabled={pending !== null} busy={pending === 'rotate'} onClick={() => run('rotate', () => rotateRoomCode(room.id), '房间号已更换')} className="mt-3 w-full">
              <Icon name="refresh" className="size-4" />
              更换房间号
            </Button>
          </div>
          <div className="border-t border-line pt-5">
            <p className="text-sm font-medium">关闭房间</p>
            <p className="mt-1 min-h-5 text-xs leading-5 text-muted">所有成员将失去访问权限，相关分享链接会被撤销。</p>
            <Button variant="danger" disabled={pending !== null} onClick={() => ask({ kind: 'close' })} className="mt-3 w-full">关闭房间</Button>
          </div>
          {notice && <div><StatusLine tone={notice?.tone === 'error' ? 'error' : 'success'}>{notice?.text}</StatusLine></div>}
        </div>
        </div>
        )}
      </Dialog>
    </>
  )
}

function describeActionError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return '会话已失效，请重试'
    if (error.code === 'OWNER_MUST_CLOSE') return '房主不能直接离开，请先关闭房间'
    if (error.code === 'OWNER_REQUIRED' || error.code === 'FORBIDDEN') return '已没有管理权限'
    if (error.status === 409) return '房间状态已变化，请刷新后重试'
    if (error.status === 429) return error.retryAfter ? `操作太频繁，${error.retryAfter} 秒后再试` : '操作太频繁，请稍后再试'
    if (error.status === 0) return '请求超时，正在重新确认状态'
  }
  return '操作未完成，请重试'
}

// Same "response lost" rule as the back dialog: re-read the authoritative memberships first, then
// the snapshot. Only network/5xx responses go through this path; 401/403/404/409 keep semantics.
async function reverifyMembership(roomId: string): Promise<'gone' | 'stay' | 'unknown'> {
  try {
    const live = await fetchSession()
    if (!live.memberships.some((m) => m.room.id === roomId)) return 'gone'
  } catch {
    return 'unknown'
  }
  try {
    await fetchRoomSnapshot(roomId)
    return 'stay'
  } catch (snapshotError) {
    if (isApiError(snapshotError) && [401, 403, 404].includes(snapshotError.status)) return 'gone'
    return 'unknown'
  }
}

// One row keeps its own instance: description is static copy, the status slot below the row only
// swaps saving / error text. No key remount, no whole-row transition, no layout reservation.
function RuleRow({ title, description, switchLabel, checked, saving, saveText, error, onChange }: {
  title: string
  description: string
  switchLabel: string
  checked: boolean
  saving: boolean
  saveText: string
  error: string | null
  onChange: () => void
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink">{title}</p>
          <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <span className="grid size-4 place-items-center" aria-hidden="true">
            <span className={`transition-opacity duration-150 ease-out motion-reduce:transition-none ${saving ? 'opacity-100' : 'opacity-0'}`}>
              {saving && <Spinner className="size-3.5 text-muted" />}
            </span>
          </span>
          <RuleSwitch checked={checked} disabled={saving} label={switchLabel} onChange={onChange} />
        </span>
      </div>
      <span className="sr-only" role="status">{saving ? saveText : ''}</span>
      {error && (
        <div className="mt-1.5">
          <p className="anim-fade text-xs leading-5 text-danger" role="alert">{error}</p>
        </div>
      )}
    </div>
  )
}

// Purpose: state indication for the three independent join rules. Only transform and opacity
// move: the knob slides, the track cross-fades. Rapid toggles retarget the same transition and
// layout never shifts because the switch keeps a fixed size.
function RuleSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border px-0.5 transition-[background-color,border-color,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface'}`}
    >
      <span
        aria-hidden="true"
        className={`size-5 rounded-full shadow transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${checked ? 'translate-x-5' : 'translate-x-0'}`}
        style={{ backgroundColor: 'var(--c-raised)' }}
      />
    </button>
  )
}

function ConfirmPanel({ body, busy, onCancel, onConfirm }: { body: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div>
      <p className="text-sm leading-6 text-muted">{body}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy} data-confirm-cancel>取消</Button>
        <Button variant="danger" onClick={onConfirm} busy={busy}>确认</Button>
      </div>
    </div>
  )
}

function confirmTitle(kind?: 'close' | 'leave' | 'kick') {
  return kind === 'close' ? '关闭房间？' : kind === 'leave' ? '离开房间？' : '移出这位成员？'
}

function confirmBody(kind?: 'close' | 'leave' | 'kick') {
  return kind === 'close'
    ? '关闭后，所有成员都无法再访问这个房间，房间内的分享链接也会失效。'
    : kind === 'leave'
      ? '离开后需要重新输入房间号才能回来。'
      : '该成员将无法继续访问这个房间。'
}
