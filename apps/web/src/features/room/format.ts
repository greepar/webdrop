export function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

// Server limits are decimal bytes (100,000,000 = 100 MB), so use SI units to avoid showing "95.4 MB"
// for a 100 MB cap.
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unit]}`
}

export function formatRemaining(iso: string, now: number) {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return '已到期'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours} 小时 ${minutes} 分后到期`
  return `${Math.max(minutes, 1)} 分钟后到期`
}

export function assetKind(contentType: string): 'image' | 'video' | 'file' {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  return 'file'
}
