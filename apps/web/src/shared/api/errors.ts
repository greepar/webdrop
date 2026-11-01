export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter: number | null

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Contract errors are `{error: {code, message, requestId, details?}}`; clients branch on `code`, never on text.
export function parseErrorPayload(status: number, payload: unknown, retryAfterHeader: string | null) {
  const retryHeader = Number(retryAfterHeader)
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const code = error && typeof error.code === 'string' ? error.code : `HTTP_${status}`
  const message = error && typeof error.message === 'string' ? error.message : '请求失败'
  return new ApiError(status, code, message, retryAfter)
}
