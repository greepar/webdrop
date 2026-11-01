import type { ThemePreference } from '@/shared/theme/types'
import { useTheme } from '@/shared/theme/use-theme'
import { Icon, type IconName } from '@/shared/ui/Icon'

const options: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'system', label: '跟随系统', icon: 'monitor' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
]

// Segmented control: each option is a real radio so keyboard arrows and screen readers work natively.
export function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  return (
    <div role="radiogroup" aria-label="外观" className="sketch-pill inline-flex items-center gap-0.5 border border-line bg-raised p-0.5">
      {options.map((option) => {
        const checked = preference === option.value
        return (
          <label
            key={option.value}
            title={option.label}
            className={`sketch-pill grid size-9 cursor-pointer place-items-center transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${checked ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'}`}
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={checked}
              onChange={() => setPreference(option.value)}
              className="sr-only"
              aria-label={option.label}
            />
            <Icon name={option.icon} className="size-4" />
          </label>
        )
      })}
    </div>
  )
}
