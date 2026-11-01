// The CSRF token is delivered only in the JSON body (protocol.md §建立会话). It lives in memory:
// never in localStorage, never in a cookie the page can read. A reload restores it via GET /session.
let csrfToken: string | null = null

export function getCsrfToken(): string | null {
  return csrfToken
}

export function setCsrfToken(value: string | null) {
  csrfToken = value
}

// Idempotency keys are 8–128 ASCII characters. Random per user action, so retries of the same action
// reuse the key and a new action never collides with an old one.
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
