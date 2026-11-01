import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeContext } from '@/shared/theme/theme-context'
import type { ResolvedTheme, ThemePreference } from '@/shared/theme/types'

const THEME_STORAGE_KEY = 'webdrop-theme'

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  const resolved = preference === 'system' ? system : preference

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', onChange)
    window.addEventListener('focus', onChange)
    document.addEventListener('visibilitychange', onChange)
    onChange()
    return () => {
      media.removeEventListener('change', onChange)
      window.removeEventListener('focus', onChange)
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreferenceState(readPreference())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#1c1d1f' : '#f3f2ee')
  }, [resolved])

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value)
    try {
      if (value === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, value)
    } catch {
      // Storage may be blocked (private mode); the choice still applies for this page.
    }
  }, [])

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
