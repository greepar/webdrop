// Browsers never expose the real device name (hostname, "张三的 iPhone"): User-Agent and
// Client Hints only reveal platform + browser brand. So the display name is a readable
// "Browser · OS" guess the user can rename; the server stays authoritative for storage.
export function defaultDeviceName(): string {
  const browser = browserName()
  const os = osName()
  if (browser && os) return `${browser} · ${os}`
  return browser || os || 'Device'
}

function browserName(): string | null {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands
  if (brands?.length) {
    // Client Hints order is not relevance order; prefer a real browser brand over the Chromium shim.
    const names = brands.map((b) => b.brand)
    const pick = names.find((n) => /chrome|edge|firefox|safari|opera|brave|arc/i.test(n) && !/chromium/i.test(n))
      ?? names.find((n) => !/not[.\s]?a.?brand|chromium/i.test(n))
    if (pick) return cleanBrand(pick)
  }
  const ua = navigator.userAgent
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera'
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox'
  if (/\bCriOS\/|\bChrome\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua)) return 'Safari'
  return null
}

function osName(): string | null {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (platform) return cleanBrand(platform)
  const ua = navigator.userAgent
  if (/\biPhone|\biPad|\biPod\b/.test(ua)) return 'iOS'
  if (/\bAndroid\b/.test(ua)) return 'Android'
  if (/\bMacintosh|\bMac OS X\b/.test(ua)) return 'macOS'
  if (/\bWindows\b/.test(ua)) return 'Windows'
  if (/\bLinux\b/.test(ua)) return 'Linux'
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS'
  return null
}

function cleanBrand(brand: string): string {
  return brand.replace(/^"(.*)"$/, '$1').trim() || brand
}

// Server rule mirrored for client-side validation: non-empty, max 80 UTF-8 bytes.
export function deviceNameError(name: string): string | null {
  if (name.trim().length === 0) return '设备名不能为空'
  if (new TextEncoder().encode(name.trim()).length > 80) return '设备名超过 80 字节'
  return null
}
