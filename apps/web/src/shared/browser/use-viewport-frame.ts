import { useEffect, useState, type CSSProperties } from 'react'

// The keyboard can resize Safari's visual viewport without resizing its layout viewport.
// Do not fit to a pinched viewport: the user must retain normal zooming and panning.
export function useViewportFrame(): CSSProperties | undefined {
  const [frame, setFrame] = useState<{ height: number; top: number } | null>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let scheduled = 0
    const read = () => {
      scheduled = 0
      if (viewport.scale !== 1) { setFrame(null); return }
      const height = Math.round(viewport.height)
      const top = Math.round(viewport.offsetTop)
      if (height <= 0) return
      setFrame(previous => previous?.height === height && previous.top === top ? previous : { height, top })
    }
    const update = () => {
      if (!scheduled) scheduled = requestAnimationFrame(read)
    }
    read()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(scheduled)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return frame ? { position: 'fixed', insetInline: 0, top: frame.top, height: frame.height } : undefined
}
