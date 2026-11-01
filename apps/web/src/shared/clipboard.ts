// Clipboard writes need a user gesture on iOS; callers must invoke this directly from an onClick.
// Falls back to a hidden textarea where the async API is unavailable or denied.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? { start: focused.selectionStart, end: focused.selectionEnd } : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    if (focused?.isConnected) {
      focused.focus({ preventScroll: true })
      if (selection && selection.start !== null && selection.end !== null && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) focused.setSelectionRange(selection.start, selection.end)
    }
  }
}

// Reads text from the clipboard only in response to a user gesture; returns null when blocked.
export async function readClipboardText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

// Reads files (screenshots, images, videos, any file) from the clipboard. Returns an empty array
// when the clipboard has no files or the API is unavailable/denied. Call from a user gesture.
export async function readClipboardFiles(): Promise<File[]> {
  try {
    const items = await navigator.clipboard?.read?.()
    if (!items) return []
    const files: File[] = []
    for (const item of items) {
      for (const type of item.types) {
        try {
          const blob = await item.getType(type)
          // Skip the HTML wrapper browsers add alongside a copied file; keep the real payloads.
          if (blob.size === 0) continue
          const subtype = type.split('/')[1]?.split(';')[0]?.split('+')[0]
          const ext = subtype ? `.${subtype}` : ''
          files.push(new File([blob], `clipboard-${Date.now()}${ext}`, { type: blob.type || type }))
        } catch {
          // One unreadable type must not block the others.
        }
      }
    }
    return files
  } catch {
    return []
  }
}
