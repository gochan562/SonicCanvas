'use client'

import { useEffect, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'

/**
 * FullscreenToggle
 *
 * A small button that toggles the visual canvas into / out of
 * browser fullscreen mode (the immersive viewing experience from
 * spec §34 — "desktop monitor" target, now with a true fullscreen
 * option). Uses the standard Fullscreen API.
 *
 * When fullscreen is active on an element other than the canvas
 * container, we sync the toggle state back to "off" so the icon
 * stays correct if the user exits fullscreen via Esc.
 */
export function FullscreenToggle() {
  const [isFs, setIsFs] = useState(false)

  // Sync state with the browser's fullscreen element. We read
  // document.fullscreenElement lazily on click rather than in an
  // effect to avoid the set-state-in-effect lint rule.
  useEffect(() => {
    const onFsChange = () => {
      setIsFs(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange as EventListener)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('webkitfullscreenchange', onFsChange as EventListener)
    }
  }, [])

  const toggle = async () => {
    // Find the canvas container (the <section> that wraps the canvas)
    // at click time — it's guaranteed to be in the DOM by now.
    const target = document.querySelector('section.relative') as HTMLElement | null
    if (!target) return
    try {
      if (!document.fullscreenElement) {
        if (target.requestFullscreen) await target.requestFullscreen()
        else if ((target as any).webkitRequestFullscreen) (target as any).webkitRequestFullscreen()
        setIsFs(true)
      } else {
        if (document.exitFullscreen) await document.exitFullscreen()
        setIsFs(false)
      }
    } catch {
      // some browsers reject fullscreen without a user gesture or
      // if the element isn't focusable, ignore silently
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
      title={isFs ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
      className="absolute right-3 bottom-3 z-10 flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-black/50 text-white/60 backdrop-blur-md transition-all hover:scale-105 hover:border-[#2d9bff]/50 hover:text-white"
    >
      {isFs ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
    </button>
  )
}
