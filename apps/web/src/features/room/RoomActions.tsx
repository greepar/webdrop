import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, IconButton, StatusLine } from '@/shared/ui/primitives'
import { Icon } from '@/shared/ui/Icon'
import { closeRoom, leaveRoom, removeMember, rotateRoomCode, setJoinPolicy } from '@/features/room/api'
import type { Member, Room } from '@/shared/types/domain'

type Props = {
  room: Room
  members: Member[]
  selfMemberId: string
  isOwner: boolean
  onChanged: () => void
  onLeft: () => void
}

// Owner-only controls follow the caller's membership role from the session. The server still
// checks every call; hiding a button is never the authorization.
export function RoomActions({ room, members, selfMemberId, isOwner, onChanged, onLeft }: Props) {
  const [open, setOpen] = useState<'members' | 'manage' | null>(null)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<null | { kind: 'close' | 'leave' | 'kick'; memberId?: string }>(null)
  // Direction of the in-dialog step change, so forward and back animate opposite ways.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const contentRef = useRef<HTMLDivElement>(null)
  const owner = isOwner

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

  const run = async (action: () => Promise<unknown>, success: string, after?: () => void) => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
      setNotice({ tone: 'success', text: success })
      if (after) after()
      else onChanged()
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status: number }).status : 0
      setNotice({ tone: 'error', text: status === 403 ? '没有权限执行这个操作' : status === 409 ? '房间状态已变化，请刷新后重试' : '操作未完成，请重试' })
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = async () => {
    if (!confirm) return
    const current = confirm
    if (current.kind === 'close') {
      await run(() => closeRoom(room.id), '房间已关闭', () => onLeft())
    } else if (current.kind === 'leave') {
      await run(() => leaveRoom(room.id), '已离开房间', () => onLeft())
    } else if (current.memberId) {
      const memberId = current.memberId
      await run(() => removeMember(room.id, memberId), '已移出成员')
    }
    setConfirm(null)
  }

  // One modal at a time: a confirmation replaces the panel's body and title instead of stacking a
  // second dialog over the first.
  const closePanel = () => {
    setConfirm(null)
    setOpen(null)
  }
  const backFromConfirm = () => {
    setDirection('back')
    setConfirm(null)
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 sm:hidden">
          <IconButton icon="users" label={`成员，${members.length} 人`} onClick={() => setOpen('members')} />
          {owner && <IconButton icon="more" label="房间设置" onClick={() => setOpen('manage')} />}
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <Button variant="secondary" onClick={() => setOpen('members')} className="min-h-10 px-4 text-sm">
            <Icon name="users" className="size-4" />
            成员 {members.length}
          </Button>
          {owner && (
            <Button variant="secondary" onClick={() => setOpen('manage')} className="min-h-10 px-4 text-sm">
              <Icon name="more" className="size-4" />
              管理
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
            <ConfirmPanel body={confirmBody(confirm.kind)} busy={busy} onCancel={backFromConfirm} onConfirm={onConfirm} />
          </div>
        ) : (
        <div key="list" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
        <ul className="flex flex-col divide-y divide-line">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{member.displayName}{member.id === selfMemberId && '（我）'}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {member.role === 'owner' ? '房主' : '成员'} · <span aria-label={member.presence === 'online' ? '在线' : '离线'}>{member.presence === 'online' ? '在线' : '离线'}</span>
                </p>
              </div>
              {owner && member.role !== 'owner' && member.id !== selfMemberId && (
                <Button variant="ghost" onClick={() => ask({ kind: 'kick', memberId: member.id })} className="min-h-9 px-3 text-xs text-danger">
                  移出
                </Button>
              )}
            </li>
          ))}
        </ul>
        {!owner && (
          <div className="mt-5 border-t border-line pt-5">
            <Button variant="danger" onClick={() => ask({ kind: 'leave' })} className="w-full">离开房间</Button>
          </div>
        )}
        <div className="mt-3"><StatusLine tone={notice?.tone === 'error' ? 'error' : 'success'}>{notice?.text}</StatusLine></div>
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
            <ConfirmPanel body={confirmBody(confirm.kind)} busy={busy} onCancel={backFromConfirm} onConfirm={onConfirm} />
          </div>
        ) : (
        <div key="settings" data-dir={direction} className="anim-swap" ref={contentRef} tabIndex={-1}>
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-sm font-medium">加入方式</p>
            <p className="mt-1 text-xs leading-5 text-muted">锁定后，新的设备无法通过房间号加入。已在房间的成员不受影响。</p>
            <div className="mt-3 flex gap-2">
              {(['open', 'locked'] as const).map((policy) => (
                <Button
                  key={policy}
                  variant={room.joinPolicy === policy ? 'primary' : 'secondary'}
                  disabled={busy}
                  onClick={() => run(() => setJoinPolicy(room.id, policy), policy === 'locked' ? '已锁定加入' : '已开放加入')}
                  className="flex-1"
                  aria-pressed={room.joinPolicy === policy}
                >
                  <Icon name={policy === 'locked' ? 'lock' : 'unlock'} className="size-4" />
                  {policy === 'locked' ? '锁定' : '开放'}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-sm font-medium">更换房间号</p>
            <p className="mt-1 text-xs leading-5 text-muted">原房间号会立即失效。</p>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => rotateRoomCode(room.id), '房间号已更换')} className="mt-3 w-full">
              <Icon name="refresh" className="size-4" />
              更换房间号
            </Button>
          </div>
          <div className="border-t border-line pt-5">
            <p className="text-sm font-medium">关闭房间</p>
            <p className="mt-1 text-xs leading-5 text-muted">所有成员将失去访问权限，相关分享链接会被撤销。</p>
            <Button variant="danger" disabled={busy} onClick={() => ask({ kind: 'close' })} className="mt-3 w-full">关闭房间</Button>
          </div>
          <StatusLine tone={notice?.tone === 'error' ? 'error' : 'success'}>{notice?.text}</StatusLine>
        </div>
        </div>
        )}
      </Dialog>
    </>
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
