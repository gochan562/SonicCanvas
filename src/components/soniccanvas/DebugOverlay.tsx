'use client'

import { useEffect, useState } from 'react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import type { RenderStats } from '@/lib/soniccanvas/visuals/VisualEngine'

/**
 * DebugOverlay (spec §41)
 *
 * Development-only overlay showing FPS, current scene, resolution,
 * and audio feature bars (bass/mid/treble/energy/beat). Hidden when
 * `debug` is false in the store. The visual engine publishes stats
 * via the `onStats` callback; we read them here.
 *
 * Also displays live audio features by polling the analyzer each
 * animation frame.
 */
export function DebugOverlay() {
  const debug = useSonicStore((s) => s.debug)
  const [stats, setStats] = useState<RenderStats | null>(null)
  const [features, setFeatures] = useState({
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
  })

  // subscribe to engine stats
  useEffect(() => {
    // locate the visual engine by inspecting the canvas; simpler: poll
    // window for a globally registered instance.
    const cb = (e: Event) => setStats((e as CustomEvent<RenderStats>).detail)
    window.addEventListener('soniccanvas:stats', cb as EventListener)
    return () => window.removeEventListener('soniccanvas:stats', cb as EventListener)
  }, [])

  // poll audio features via a small rAF loop (cheap, only when debug on)
  useEffect(() => {
    if (!debug) return
    let raf = 0
    const loop = () => {
      const visual = (window as any).__sonicVisual as any
      const f = visual?.getLatestFeatures?.()
      if (f) {
        setFeatures({
          bass: f.bass ?? 0,
          mid: f.mid ?? 0,
          treble: f.treble ?? 0,
          energy: f.overallEnergy ?? 0,
          beat: f.beatPulse ?? 0,
        })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [debug])

  if (!debug) return null

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-white/10 bg-black/60 px-3 py-2 font-mono text-[10px] text-white/80 backdrop-blur">
      <div className="mb-1 flex items-center gap-2 font-sans text-xs font-medium text-white">
        Debug
      </div>
      <div className="mb-1">FPS: {stats?.fps?.toFixed(0) ?? '—'}</div>
      <div className="mb-1">Scene: {stats?.scene ?? '—'}{stats?.transitioning ? ' ⟳' : ''}</div>
      <div className="mb-1">Res: {stats?.width ?? '—'}×{stats?.height ?? '—'}</div>
      <div className="mt-2 space-y-1">
        <DebugBar label="Bass" value={features.bass} color="#ff2d95" />
        <DebugBar label="Mid" value={features.mid} color="#a855f7" />
        <DebugBar label="Treble" value={features.treble} color="#2d9bff" />
        <DebugBar label="Energy" value={features.energy} color="#f59e0b" />
        <DebugBar label="Beat" value={features.beat} color="#10b981" />
      </div>
    </div>
  )
}

function DebugBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-9 text-white/60">{label}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded bg-white/10">
        <div
          className="h-full"
          style={{ width: `${Math.min(100, value * 100)}%`, background: color }}
        />
      </div>
    </div>
  )
}
