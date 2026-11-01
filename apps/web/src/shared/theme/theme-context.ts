import { createContext } from 'react'
import type { ThemePreference, ResolvedTheme } from '@/shared/theme/types'

export const ThemeContext = createContext<{
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (value: ThemePreference) => void
} | null>(null)
