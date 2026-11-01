import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '@/shared/api/client'
import { isAbortError, isApiError } from '@/shared/api/errors'
import { parseChallenge } from '@/shared/api/schema'
import { unwrapData } from '@/shared/api/validate'
import type { Proof } from '@/shared/types/domain'

export type PowStatus =
  | { phase: 'idle' }
  | { phase: 'fetching' }
  | { phase: 'solving' }
  | { phase: 'failed'; message: string; retryable: boolean }
  | { phase: 'cooldown'; retryAfter: number }
  | { phase: 'solved' }

export type PowRequest = {
  action: 'room.create' | 'room.join'
  code?: string
  idempotencyKey: string
}

// Obtains a server challenge, solves it in a worker, and returns the proof. The proof is only a
// ticket to send with the protected request; the server decides whether it is accepted.
export function usePow() {
  const [status, setStatus] = useState<PowStatus>({ phase: 'idle' })
  const cooldownUntil = useRef(0)
  const cooling = status.phase === 'cooldown'
  useEffect(() => {
    if (!cooling) return
    const update = () => {
      const seconds = Math.max(0, Math.ceil((cooldownUntil.current - Date.now()) / 1000))
      setStatus(seconds ? { phase: 'cooldown', retryAfter: seconds } : { phase: 'idle' })
    }
    const timer = window.setInterval(update, 1000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [cooling])
  const workerRef = useRef<Worker | null>(null)
  const runRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  const settleRef = useRef<(() => void) | null>(null)

  const stopWorker = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = null
    settleRef.current?.()
    settleRef.current = null
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  useEffect(() => () => {
    runRef.current += 1
    stopWorker()
  }, [stopWorker])

  const cancel = useCallback(() => {
    runRef.current += 1
    stopWorker()
    setStatus({ phase: 'idle' })
  }, [stopWorker])

  const obtainProof = useCallback(async (body: PowRequest): Promise<Proof | null> => {
    stopWorker()
    const run = ++runRef.current
    const alive = () => run === runRef.current
    setStatus({ phase: 'fetching' })

    let challenge
    try {
      const controller = new AbortController()
      requestRef.current = controller
      const payload = await request('/pow/challenges', { method: 'POST', body, signal: controller.signal })
      challenge = parseChallenge(unwrapData(payload, 'pow.challenge'))
    } catch (error) {
      if (!alive() || isAbortError(error)) return null
      if (isApiError(error) && error.status === 429 && error.retryAfter) {
        cooldownUntil.current = Date.now() + error.retryAfter * 1000
        setStatus({ phase: 'cooldown', retryAfter: error.retryAfter })
      } else {
        setStatus({ phase: 'failed', message: '验证暂时不可用，请稍后再试', retryable: true })
      }
      return null
    }
    if (!alive()) return null

    const remaining = Date.parse(challenge.expiresAt) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setStatus({ phase: 'failed', message: '验证已过期，请重试', retryable: true })
      return null
    }
    setStatus({ phase: 'solving' })
    let worker: Worker
    try {
      worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      setStatus({ phase: 'failed', message: '无法启动验证，请刷新后重试', retryable: true })
      return null
    }
    workerRef.current = worker

    return new Promise<Proof | null>((resolve) => {
      let settled = false
      const timer = window.setTimeout(() => finish(null, {
        phase: 'failed', message: remaining <= 120_000 ? '验证已过期，请重试' : '验证耗时过长，请重试', retryable: true,
      }), Math.min(remaining, 120_000))
      settleRef.current = () => {
        settled = true
        window.clearTimeout(timer)
        resolve(null)
      }
      const finish = (proof: Proof | null, next: PowStatus) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        settleRef.current = null
        stopWorker()
        if (alive()) setStatus(next)
        resolve(proof)
      }
      worker.onmessage = (event: MessageEvent<{ type: string; nonce?: string }>) => {
        if (!alive()) return resolve(null)
        if (event.data.type === 'solved' && typeof event.data.nonce === 'string') {
          finish({ challengeId: challenge.challengeId, nonce: event.data.nonce }, { phase: 'solved' })
          return
        }
        finish(null, { phase: 'failed', message: '验证失败，请重试', retryable: true })
      }
      worker.onerror = () => finish(null, { phase: 'failed', message: '验证失败，请重试', retryable: true })
      worker.postMessage({
        type: 'solve',
        id: run,
        request: { input: challenge.input, difficulty: challenge.difficulty },
      })
    })
  }, [stopWorker])

  return { status, obtainProof, cancel }
}
