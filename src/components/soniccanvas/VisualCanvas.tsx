'use client'

import { useEffect, useRef, type RefObject } from 'react'
import type { AudioEngine } from '@/lib/soniccanvas/audio/AudioEngine'
import type { VisualEngine } from '@/lib/soniccanvas/visuals/VisualEngine'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import type { SceneId } from '@/lib/soniccanvas/audio/types'
import type { MappingKey } from '@/lib/soniccanvas/visuals/MappingCurves'

interface VisualCanvasProps {
  audioRef: RefObject<AudioEngine | null>
  visualRef: RefObject<VisualEngine | null>
  onCanvasReady: (canvas: HTMLCanvasElement) => void
}

/**
 * VisualCanvas
 *
 * Mounts the WebGL <canvas> element and notifies the parent when the
 * canvas is ready so the VisualEngine can be constructed. Also handles
 * resize via ResizeObserver so the renderer always matches the
 * preview area.
 *
 * The actual rendering happens inside the VisualEngine's RAF loop —
 * React doesn't touch the canvas after mount.
 *
 * Global keyboard shortcuts (spec §25 optional):
 *   Space      play / pause
 *   ← / →      seek -5s / +5s
 *   ↑ / ↓      volume up / down
 *   M          mute / unmute
 *   1-5        switch scene (Liquid / Orbit / Tunnel / Grid / Particles)
 *   A          toggle auto-scene mode
 *   D          toggle debug overlay
 *   ? / Esc    handled by KeyboardShortcutsHelp component
 */
const SCENE_KEYS: Record<string, SceneId> = {
  '1': 'liquid',
  '2': 'orbit',
  '3': 'tunnel',
  '4': 'grid',
  '5': 'particles',
}

export function VisualCanvas({ audioRef, visualRef, onCanvasReady }: VisualCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // notify parent so it can construct the engine
    onCanvasReady(canvas)

    // ResizeObserver → keep the renderer in sync with parent size
    const ro = new ResizeObserver(() => {
      visualRef.current?.resize()
    })
    ro.observe(canvas.parentElement ?? canvas)
    return () => ro.disconnect()
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) return
      const audio = audioRef.current
      const visual = visualRef.current
      // Allow shortcuts to work even without audio loaded, but bail
      // for audio-specific keys when no buffer is loaded.
      const hasBuffer = !!audio?.getBuffer()

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          if (!hasBuffer) return
          e.preventDefault()
          if (audio!.isCurrentlyPlaying()) audio!.pause()
          else void audio!.play()
          break
        case 'ArrowLeft':
          if (!hasBuffer) return
          e.preventDefault()
          void audio!.seek(Math.max(0, audio!.getCurrentTime() - 5))
          break
        case 'ArrowRight':
          if (!hasBuffer) return
          e.preventDefault()
          void audio!.seek(Math.min(audio!.getDuration(), audio!.getCurrentTime() + 5))
          break
        case 'ArrowUp':
          if (!hasBuffer) return
          e.preventDefault()
          audio!.setVolume(Math.min(1, audio!.getVolume() + 0.05))
          break
        case 'ArrowDown':
          if (!hasBuffer) return
          e.preventDefault()
          audio!.setVolume(Math.max(0, audio!.getVolume() - 0.05))
          break
        case 'm':
        case 'M':
          if (!hasBuffer) return
          e.preventDefault()
          audio!.setVolume(audio!.getVolume() > 0 ? 0 : 1)
          break
        case '1':
        case '2':
        case '3':
        case '4':
        case '5': {
          if (!visual) return
          const sid = SCENE_KEYS[e.key]
          if (!sid) return
          // Don't switch if auto-scene is on (would conflict)
          if (useSonicStore.getState().autoScene) return
          e.preventDefault()
          visual.setScene(sid)
          useSonicStore.getState().setScene(sid)
          break
        }
        case 'a':
        case 'A': {
          if (!visual) return
          e.preventDefault()
          const next = !visual.getAutoScene().isEnabled()
          visual.setAutoSceneMode(next)
          useSonicStore.getState().setAutoScene(next)
          break
        }
        case 'd':
        case 'D': {
          e.preventDefault()
          useSonicStore.getState().setDebug(!useSonicStore.getState().debug)
          break
        }
        // Shift+1-4: solo bass/beat/treble/energy (Shift+1 toggles bass solo, etc.)
        case '!': // Shift+1
        case '@': // Shift+2
        case '#': // Shift+3
        case '$': // Shift+4
        {
          const soloMap: Record<string, MappingKey> = {
            '!': 'bass', '@': 'beat', '#': 'treble', '$': 'energy',
          }
          const sf = soloMap[e.key]
          if (!sf) return
          e.preventDefault()
          const current = useSonicStore.getState().soloFeature
          useSonicStore.getState().setSoloFeature(current === sf ? null : sf)
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [audioRef, visualRef])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      aria-label="Procedural music visualization"
      role="img"
    />
  )
}
