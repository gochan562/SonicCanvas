'use client'

import { useEffect, useRef } from 'react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { SCENES } from '@/lib/soniccanvas/config/defaults'
import { Music2, Radio, Headphones, Clock } from 'lucide-react'
import type { MappingKey } from '@/lib/soniccanvas/visuals/MappingCurves'

const SOLO_COLORS: Record<MappingKey, string> = {
  bass: '#ff2d95',
  beat: '#f59e0b',
  treble: '#2d9bff',
  energy: '#10b981',
}

const SOLO_LABELS: Record<MappingKey, string> = {
  bass: 'Bass',
  beat: 'Beat',
  treble: 'Treble',
  energy: 'Energy',
}

/**
 * NowPlayingOverlay
 *
 * A subtle floating overlay in the top-right of the canvas that shows:
 *   - the track name + a small "now playing" label
 *   - a live animated equalizer (4 bars) when audio is playing
 *   - the current scene name + an "auto" badge if auto-scene is on
 *   - an auto-scene timeline progress bar (when auto-scene is enabled)
 *   - a "solo" badge showing which feature is isolated (if any)
 *
 * Fades out gracefully when no track is loaded.
 */
export function NowPlayingOverlay() {
  const track = useSonicStore((s) => s.track)
  const player = useSonicStore((s) => s.player)
  const activeScene = useSonicStore((s) => s.activeScene)
  const autoScene = useSonicStore((s) => s.autoScene)
  const soloFeature = useSonicStore((s) => s.soloFeature)

  // DOM-direct rAF loop: update the progress bar width + countdown text
  // without React state (avoids set-state-in-effect lint rule).
  const barRef = useRef<HTMLDivElement | null>(null)
  const timeRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!autoScene) return
    let raf = 0
    const poll = () => {
      raf = requestAnimationFrame(poll)
      const visual = (window as any).__sonicVisual as any
      const info = visual?.getAutoScene?.()?.getTimelineInfo?.()
      if (info && barRef.current && timeRef.current) {
        const progress = 1 - info.timeUntilNext / info.maxSceneTime
        barRef.current.style.width = `${Math.min(100, progress * 100)}%`
        timeRef.current.textContent = `${info.timeUntilNext.toFixed(1)}s`
      }
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [autoScene])

  if (!track) return null

  const sceneInfo = SCENES.find((s) => s.id === activeScene)

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5">
      <div className="rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-right backdrop-blur-md">
        <div className="flex items-center justify-end gap-1.5 text-[9px] uppercase tracking-wider text-white/40">
          <Music2 className="h-2.5 w-2.5" />
          <span>Now playing</span>
          {player.isPlaying && (
            <span className="ml-1 inline-flex items-end gap-[2px]" aria-hidden="true">
              <span className="sonic-eq-bar !h-2.5" />
              <span className="sonic-eq-bar !h-2.5" />
              <span className="sonic-eq-bar !h-2.5" />
              <span className="sonic-eq-bar !h-2.5" />
            </span>
          )}
        </div>
        <div className="max-w-[200px] truncate text-xs font-medium text-white">
          {track.fileName}
        </div>
      </div>
      <div className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/50 px-2.5 py-1 text-[10px] text-white/70 backdrop-blur-md">
        <Radio className="h-3 w-3 text-[#ff2d95]" />
        <span className="font-medium text-white">{sceneInfo?.name ?? '—'}</span>
        {autoScene && (
          <span className="rounded bg-[#a855f7]/20 px-1 text-[9px] uppercase tracking-wide text-[#c084fc]">
            auto
          </span>
        )}
      </div>
      {/* Auto-scene timeline: shows progress toward next forced rotation */}
      {autoScene && (
        <div className="w-[140px] rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between text-[9px] text-white/40">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              Next scene
            </span>
            <span ref={timeRef} className="font-mono text-white/60">
              —
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              ref={barRef}
              className="h-full rounded-full bg-gradient-to-r from-[#a855f7] to-[#2d9bff] transition-all duration-300"
              style={{ width: '0%' }}
            />
          </div>
        </div>
      )}
      {soloFeature && (
        <div
          className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[10px] backdrop-blur-md"
          style={{
            borderColor: SOLO_COLORS[soloFeature] + '60',
            background: SOLO_COLORS[soloFeature] + '15',
            color: '#fff',
          }}
        >
          <Headphones className="h-3 w-3" style={{ color: SOLO_COLORS[soloFeature] }} />
          <span className="font-medium">Solo: {SOLO_LABELS[soloFeature]}</span>
        </div>
      )}
    </div>
  )
}
