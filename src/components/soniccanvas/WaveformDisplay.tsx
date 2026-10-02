'use client'

import { useEffect, useRef } from 'react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'

/**
 * WaveformDisplay
 *
 * A tiny live waveform + spectrum mini-visualization drawn into a
 * <canvas> next to the play/pause controls in the player bar (spec
 * §46 — "waveform timeline" + "frequency graph").
 *
 * Reads the latest AudioFeatures from the VisualEngine each frame
 * (via the global window.__sonicVisual back-channel) and draws:
 *   - a thin spectrum bar chart across the canvas (log-spaced bins)
 *   - the live waveform overlaid on top
 *
 * Rendering is intentionally cheap (small canvas, single draw per
 * frame, no alpha blending tricks) so it doesn't impact the main
 * WebGL render loop.
 */
export function WaveformDisplay({
  width = 160,
  height = 36,
}: {
  width?: number
  height?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const track = useSonicStore((s) => s.track)

  useEffect(() => {
    // Don't start the rAF loop until a track is loaded (we render
    // null when !track, so the canvas ref isn't bound until then).
    if (!track) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const visual = (window as any).__sonicVisual as any
      const f = visual?.getLatestFeatures?.()
      ctx.clearRect(0, 0, width, height)

      if (!f) {
        // idle state: a thin dim line
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, height / 2)
        ctx.lineTo(width, height / 2)
        ctx.stroke()
        return
      }

      // spectrum bars (background, dim)
      const spectrum: Uint8Array = f.spectrum
      const bars = 32
      const barW = width / bars
      ctx.fillStyle = 'rgba(255, 45, 149, 0.45)'
      for (let i = 0; i < bars; i++) {
        // log-spaced index
        const t = i / bars
        const idx = Math.floor(Math.pow(t, 1.6) * spectrum.length)
        const v = spectrum[Math.min(spectrum.length - 1, idx)] / 255
        const h = v * (height * 0.9)
        ctx.fillRect(i * barW + 1, (height - h) / 2, barW - 2, h)
      }

      // waveform overlay
      const wf: Float32Array = f.waveform
      ctx.strokeStyle = 'rgba(45, 155, 255, 0.95)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let i = 0; i < wf.length; i++) {
        const x = (i / wf.length) * width
        const y = height / 2 - wf[i] * (height * 0.4)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // beat pulse: flash a horizontal line
      if (f.beatPulse > 0.05) {
        ctx.fillStyle = `rgba(255, 234, 0, ${f.beatPulse * 0.5})`
        ctx.fillRect(0, 0, width, height)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [width, height, track])

  if (!track) return null

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="hidden md:block rounded-md border border-white/5 bg-black/40"
      aria-label="Live audio waveform and spectrum"
      role="img"
    />
  )
}
