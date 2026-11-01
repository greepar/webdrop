import { env } from '@/shared/config/env'
import { ApiError, parseErrorPayload } from '@/shared/api/errors'
import { getCsrfToken } from '@/shared/api/session-token'

// Loaded lazily and only in development (see config/env.ts), so production bundles never contain it.
const loadMock = import.meta.env.DEV ? () => import('@/shared/api/mock') : undefined

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type RequestOptions = {
  method?: HttpMethod
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  // Required on the contract's idempotent writes (room create/join, text, upload create/complete, link create).
  idempotencyKey?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

// Paths are relative to /api/v1, which is prepended here. Returns the parsed JSON body as unknown.
export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  if (env.isMock && loadMock) return (await loadMock()).mockRequest(path, options)

  const { method = 'GET', body, headers = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS, idempotencyKey } = options
  const timeout = AbortSignal.timeout(timeoutMs)
  const writeHeaders: Record<string, string> = {}
  if (WRITE_METHODS.has(method)) {
    const csrf = getCsrfToken()
    if (csrf && !path.startsWith('/sessions')) writeHeaders['X-CSRF-Token'] = csrf
  }
  if (idempotencyKey) writeHeaders['Idempotency-Key'] = idempotencyKey

  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...writeHeaders,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  if (response.status === 204) return undefined
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw parseErrorPayload(response.status, payload, response.headers.get('Retry-After'))
  return payload
}

// Raw byte upload with progress. fetch has no upload progress, so live mode uses XHR.
export async function uploadBytes(
  url: string,
  file: Blob,
  { onProgress, signal }: { onProgress: (loaded: number, total: number) => void; signal: AbortSignal },
): Promise<void> {
  if (env.isMock && loadMock) return (await loadMock()).mockUploadBytes(url, file, onProgress, signal)

  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url.startsWith('http') ? url : `${window.location.origin}${url}`)
    xhr.withCredentials = true
    xhr.timeout = 120_000
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    const csrf = getCsrfToken()
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let payload: unknown = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        payload = null
      }
      reject(parseErrorPayload(xhr.status, payload, xhr.getResponseHeader('Retry-After')))
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', '网络连接中断'))
    xhr.ontimeout = () => reject(new ApiError(0, 'UPLOAD_TIMEOUT', '上传超时，请重试'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    xhr.send(file)
  })
}
