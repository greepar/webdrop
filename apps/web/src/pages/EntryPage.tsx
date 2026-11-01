import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { RoomCodeInput } from '@/features/entry/RoomCodeInput'
import { CreateRoomPanel, PasswordPrompt, PendingJoin } from '@/features/entry/JoinFlows'
import { describePow, useEntry } from '@/features/entry/use-entry'
import { DevMockBadge, Spinner, StatusLine, Button } from '@/shared/ui/primitives'
import { BrandMark } from '@/shared/ui/Icon'
import { env } from '@/shared/config/env'

export function EntryPage() {
  const entry = useEntry()
  const powText = describePow(entry.powStatus)
  const inlineError = entry.notice?.tone === 'error' ? entry.notice.text : null
  const inlineHint = entry.notice?.tone === 'info' ? entry.notice.text : null
  const cooling = entry.powStatus.phase === 'cooldown'

  return (
    <div className="flex min-h-dvh flex-col px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-8">
      <header className="flex items-center justify-between gap-4">
        <span className="min-h-10">{env.isMock && <DevMockBadge />}</span>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 pb-12 text-center">
        <div className="anim-enter flex flex-col items-center gap-5">
          <BrandMark className="size-28 sm:size-36" />
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">WebDrop</h1>
        </div>

        {entry.pending ? (
          <PendingJoin
            code={entry.code}
            expiresAt={entry.pending.request.expiresAt}
            onCancel={entry.cancelPending}
          />
        ) : (
        <div
          className="anim-enter flex w-full flex-col items-center"
          style={{ animationDelay: '60ms' }}
        >
          <RoomCodeInput
            value={entry.code}
            length={entry.length}
            disabled={entry.busyNow || cooling}
            error={entry.passwordRequired ? null : inlineError}
            hint={inlineHint}
            canCreate={entry.canCreate}
            onChange={entry.setCode}
            onCreate={entry.openCreate}
            onRandom={entry.randomRoom}
          />
          {entry.passwordRequired && (
            <PasswordPrompt
              disabled={entry.busyNow}
              error={inlineError}
              onSubmit={(password) => entry.joinRoom(password)}
              onCancel={() => entry.setCode(entry.code)}
            />
          )}
          {entry.createOpen && (
            <CreateRoomPanel
              disabled={entry.busyNow}
              password={entry.createPassword}
              approvalRequired={entry.createWithApproval}
              onPassword={entry.setCreatePassword}
              onApproval={entry.setCreateWithApproval}
              onCreate={entry.createRoom}
              onCancel={entry.cancelCreate}
            />
          )}
          <div className="mt-6 min-h-10">
            {entry.busyNow && (
              <div className="flex items-center justify-center gap-3 text-sm text-muted">
                <Spinner />
                <StatusLine>{powText ?? '处理中'}</StatusLine>
                {entry.powStatus.phase !== 'solved' && (
                  <Button variant="ghost" onClick={entry.cancelPow} className="min-h-9 px-3 text-xs">取消</Button>
                )}
              </div>
            )}
            {!entry.busyNow && cooling && <StatusLine tone="error">{powText}</StatusLine>}
            {!entry.busyNow && entry.powStatus.phase === 'failed' && (
              <StatusLine tone="error">{powText}</StatusLine>
            )}
            {entry.sessionError && (
              <div className="flex items-center gap-3 text-sm">
                <StatusLine tone="error">{entry.sessionError}</StatusLine>
                <Button variant="ghost" onClick={entry.retrySession} className="min-h-11 px-3 text-xs">重新连接</Button>
              </div>
            )}
            {entry.capabilityError && (
              <div className="flex items-center gap-3 text-sm">
                <StatusLine tone="error">无法获取房间设置</StatusLine>
                <Button variant="ghost" onClick={entry.retryCapabilities} className="min-h-9 px-3 text-xs">重试</Button>
              </div>
            )}
          </div>
        </div>
        )}
      </main>
    </div>
  )
}
