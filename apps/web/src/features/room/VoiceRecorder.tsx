import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, StatusLine } from '@/shared/ui/primitives'

export function VoiceRecorder({ disabled, onSend }: { disabled: boolean; onSend: (files: File[]) => void }) {
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const discard = useRef(false)
  const starting = useRef(false)
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const stop = (cancel: boolean) => {
    discard.current = cancel
    if (recorder.current?.state === 'recording') recorder.current.stop()
    stream.current?.getTracks().forEach(track => track.stop())
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; stop(true) }
  }, [])
  useEffect(() => {
    if (disabled) stop(true)
  }, [disabled])
  useEffect(() => {
    if (state !== 'recording') return
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [state])
  useEffect(() => {
    if (seconds >= 300) stop(false)
  }, [seconds])
  const start = async () => {
    if (disabled || starting.current || recorder.current?.state === 'recording') return
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('录音需要 HTTPS 或 localhost，以及支持录音的浏览器。')
      return
    }
    starting.current = true
    discard.current = false
    setState('starting')
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!alive.current || discard.current) { input.getTracks().forEach(track => track.stop()); if (alive.current) setState('idle'); return }
      stream.current = input
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
      const next = new MediaRecorder(input, mimeType ? { mimeType } : undefined)
      recorder.current = next
      const chunks: Blob[] = []
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      next.onerror = () => { stop(true); if (alive.current) setError('录音失败，请重试。') }
      next.onstop = () => {
        input.getTracks().forEach(track => track.stop())
        if (!alive.current) return
        setState('idle')
        if (discard.current || !chunks.length) return
        // Safari may report an empty mimeType (no webm/opus support): fall back by container.
        // The declared type only has to pass the server's contentType check (visible ASCII + '/');
        // the actual bytes are sniffed on download.
        const rawType = (next.mimeType || chunks[0]?.type || '').split(';')[0]?.trim() ?? ''
        const type = rawType.includes('/') ? rawType : 'audio/mp4'
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'
        onSend([new File(chunks, `语音-${Date.now()}.${ext}`, { type })])
      }
      next.start(1000)
      setSeconds(0)
      setState('recording')
    } catch {
      stream.current?.getTracks().forEach(track => track.stop())
      if (alive.current) { setState('idle'); setError('无法录音，请检查麦克风权限和设备。') }
    } finally { starting.current = false }
  }
  return <div className="shrink-0">
    <IconButton icon="microphone" label="录制语音" disabled={disabled || state !== 'idle'} onClick={start} className="size-11" />
    {(state !== 'idle' || error) && <div className="absolute inset-x-4 bottom-full mb-2 rounded-2xl border border-line bg-raised p-3 shadow-lg sm:inset-x-8">
      {state !== 'idle' && <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="flex-1 text-sm text-muted">{state === 'starting' ? '等待麦克风…' : `录音中 ${seconds} 秒 / 最长 5 分钟`}</span>
        <Button variant="ghost" onClick={() => stop(true)}>取消</Button>
        <Button disabled={disabled || state !== 'recording' || seconds < 1} onClick={() => stop(false)}>结束并发送</Button>
      </div>}
      {error && <div className="flex items-center justify-between gap-2"><StatusLine tone="error">{error}</StatusLine><IconButton icon="x" label="关闭提示" onClick={() => setError('')} /></div>}
    </div>}
  </div>
}
