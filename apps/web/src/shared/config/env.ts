// Mock mode is decided at build time. Production bundles never include the mock module, because the
// mock branch is only reachable when this constant is true and is dropped by the bundler otherwise.
// VITE_API_MODE=live forces the real API even in development.
export const isMock: boolean = import.meta.env.DEV && import.meta.env.VITE_API_MODE !== 'live'

export const env = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/+$/, ''),
  isMock,
} as const
