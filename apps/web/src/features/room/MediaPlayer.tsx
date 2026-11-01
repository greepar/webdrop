import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Icon, type IconName } from '@/shared/ui/Icon'

type Props = {
  kind: 'video' | 'audio'
  src: string
  filename: string
  variant?: 'inline' | 'preview'
  onError?: () => void
}

function playbackTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const total = Math.floor(value)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function ControlButton({ icon, label, onClick, className = '' }: {
  icon: IconName
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-9 shrink-0 place-items-center rounded-full text-muted transition-[color,background-color,transform] duration-150 ease-out hover:bg-surface hover:text-ink active:scale-[0.94] motion-reduce:active:scale-100 ${className}`}
    >
      <Icon name={icon} className="size-4.5" />
    </button>
  )
}

// Custom scrubber so the player never inherits platform media chrome. The 44px hit area keeps it
// touchable while the visible rail stays quiet; arrow keys seek five seconds, shift seeks thirty.
function Scrubber({ value, max, buffered, label, onSeek, onTap }: {
  onTap?: () => void
  value: number
  max: number
  buffered: number
  label: string
  onSeek: (next: number) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const gesture = useRef({ x: 0, dragged: false })
  const [draft, setDraft] = useState<number | null>(null)
  const shownValue = draft ?? value
  const ratio = max > 0 ? Math.min(1, Math.max(0, shownValue / max)) : 0
  const bufferRatio = max > 0 ? Math.min(1, Math.max(0, buffered / max)) : 0

  const seekAt = (clientX: number, commit = false) => {
    const rail = railRef.current
    if (!rail || max <= 0) return
    const rect = rail.getBoundingClientRect()
    if (rect.width <= 0) return
    const next = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max
    if (commit) onSeek(next)
    else setDraft(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 30 : 5
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      onSeek(Math.min(max, value + step))
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      onSeek(Math.max(0, value - step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onSeek(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      onSeek(max)
    }
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shownValue)}
      aria-valuetext={`${playbackTime(shownValue)} / ${playbackTime(max)}`}
      onKeyDown={onKeyDown}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { x: event.clientX, dragged: false }
        if (!onTap) seekAt(event.clientX)
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          if (Math.abs(event.clientX - gesture.current.x) > 4) gesture.current.dragged = true
          if (!onTap || gesture.current.dragged) seekAt(event.clientX)
        }
      }}
      onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        if (onTap && !gesture.current.dragged) onTap()
        else seekAt(event.clientX, true)
        setDraft(null)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => setDraft(null)}
      onPointerCancel={(event: PointerEvent<HTMLDivElement>) => {
        setDraft(null)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      className="group/scrub relative flex h-11 min-w-0 flex-1 touch-none cursor-pointer items-center outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div ref={railRef} className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="absolute inset-0 origin-left rounded-full bg-line-strong/60 transition-transform duration-150 ease-linear" style={{ transform: `scaleX(${bufferRatio})` }} />
        <div className="absolute inset-0 origin-left rounded-full bg-accent transition-transform duration-100 ease-linear" style={{ transform: `scaleX(${ratio})` }} />
      </div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 size-3 -translate-y-1/2 rounded-full border border-line-strong bg-raised shadow-sm"
        style={{ left: `calc(${ratio * 100}% - 6px)` }}
      />

    </div>
  )
}

export function MediaPlayer({ kind, src, filename, variant = 'inline', onError }: Props) {
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [muted, setMuted] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interacting = useRef(false)
  const revealControls = () => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!interacting.current) setControlsVisible(false)
    }, 1500)
  }
  useEffect(() => {
    hideTimer.current = setTimeout(() => setControlsVisible(false), 1500)
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [])
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const syncDuration = (media: HTMLMediaElement) => {
    if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration)
  }

  const syncProgress = (media: HTMLMediaElement) => {
    setCurrent(media.currentTime)
    if (media.buffered.length > 0) setBuffered(media.buffered.end(media.buffered.length - 1))
  }

  const toggle = () => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) {
      // A rejected play (autoplay policy, interruption) is not a broken file; keep the surface.
      void media.play().catch(() => undefined)
    } else {
      media.pause()
    }
  }

  const seekTo = (next: number) => {
    const media = mediaRef.current
    if (!media || duration <= 0) return
    const target = Math.min(Math.max(0, next), duration)
    media.currentTime = target
    setCurrent(target)
  }

  const toggleMute = () => {
    const media = mediaRef.current
    if (!media) return
    media.muted = !media.muted
    setMuted(media.muted)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    const frame = frameRef.current
    if (frame?.requestFullscreen) {
      void frame.requestFullscreen().catch(() => undefined)
      return
    }
    // iOS Safari exposes fullscreen on the video element rather than on the wrapper.
    const media = mediaRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    media?.webkitEnterFullscreen?.()
  }

  const mediaEvents = {
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => syncDuration(event.currentTarget),
    onDurationChange: (event: { currentTarget: HTMLMediaElement }) => syncDuration(event.currentTarget),
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => syncProgress(event.currentTarget),
    onProgress: (event: { currentTarget: HTMLMediaElement }) => syncProgress(event.currentTarget),
    onPlay: () => { setPlaying(true); revealControls() },
    onPause: () => { setPlaying(false); revealControls() },
    onEnded: () => { setPlaying(false); revealControls() },
    onVolumeChange: (event: { currentTarget: HTMLMediaElement }) => setMuted(event.currentTarget.muted),
    onError,
  }

  if (kind === 'audio') {
    return (
      <div role="group" aria-label={`${filename} 播放器`} className="sketch relative flex w-52 max-w-full items-center gap-2.5 border border-line-strong bg-mine px-3 py-1 text-ink">
        <audio ref={(element) => { mediaRef.current = element }} src={src} preload="metadata" className="hidden" {...mediaEvents} />
        <button type="button" onClick={toggle} aria-label={playing ? `暂停 ${filename}` : `播放 ${filename}`} className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <span aria-hidden="true" className="pointer-events-none relative grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
          <Icon name={playing ? 'pause' : 'play'} className="size-4" />
        </span>
        <Scrubber onTap={toggle} value={current} max={duration} buffered={buffered} onSeek={seekTo} label={`${filename} 播放进度`} />
        <span className="pointer-events-none relative shrink-0 text-sm tabular-nums text-accent" title={`${playbackTime(current)} / ${playbackTime(duration)}`}>
          {duration > 0 ? playbackTime(current > 0 && current < duration ? duration - current : duration) : '0:00'}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={frameRef}
      data-controls-visible={controlsVisible}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onFocusCapture={revealControls}
      role="group"
      aria-label={`${filename} 播放器`}
      className={`media-frame sketch relative w-full overflow-hidden border border-line bg-black ${variant === 'inline' ? 'min-w-72 max-w-full sm:min-w-96' : 'max-w-full'}`}
    >
      <div className="media-stage relative">
        <video
          ref={(element) => { mediaRef.current = element }}
          src={src}
          playsInline
          preload="metadata"
          aria-label={filename}
          onClick={toggle}
          className={`block w-full cursor-pointer bg-black object-contain ${variant === 'preview' ? 'max-h-[55dvh]' : 'max-h-[38dvh] sm:max-h-[44dvh]'}`}
          {...mediaEvents}
        />
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label={current > 0 ? `继续播放 ${filename}` : `播放 ${filename}`}
            className="absolute inset-0 grid place-items-center bg-black/25 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-accent"
          >
            <span className="grid size-12 place-items-center rounded-full border border-line bg-raised text-ink shadow-sm transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100">
              <Icon name="play" className="size-5" />
            </span>
          </button>
        )}
      </div>
      <div
        onPointerDownCapture={() => { interacting.current = true }}
        onPointerUpCapture={() => { interacting.current = false; revealControls() }}
        onPointerCancel={() => { interacting.current = false; revealControls() }}
        className="media-controls absolute inset-x-0 bottom-0 flex items-center gap-1.5 border-t border-line/40 bg-raised/55 px-2 py-0 backdrop-blur-xl"
      >
        <ControlButton icon={playing ? 'pause' : 'play'} label={playing ? '暂停' : '播放'} onClick={toggle} />
        <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">{playbackTime(current)}</span>
        <Scrubber value={current} max={duration} buffered={buffered} onSeek={seekTo} label={`${filename} 播放进度`} />
        <span className="w-8 shrink-0 font-mono text-[11px] tabular-nums text-muted">{playbackTime(duration)}</span>
        <ControlButton icon={muted ? 'volumeMute' : 'volume'} label={muted ? '取消静音' : '静音'} onClick={toggleMute} />
        <ControlButton icon={fullscreen ? 'exitFullscreen' : 'fullscreen'} label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen} />
      </div>
    </div>
  )
}
