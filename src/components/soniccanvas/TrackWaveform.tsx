'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { useEngines } from '@/lib/soniccanvas/ui/EngineContext'
import { formatTime } from './time'

/**
 * TrackWaveform
 *
 * A full-song waveform timeline showing the amplitude envelope of the
 * entire track, with click-to-seek (spec §46 — "waveform timeline").
 *
 * The waveform is computed once when the track loads by rendering the
 * decoded AudioBuffer into a downscaled peak envelope (max amplitude
 * per pixel column). This is cheap: a 3-minute song at 44.1kHz has
 * ~8M samples; we collapse that into ~400 peaks for display.
 *
 * Interaction:
 *   - hover: shows a vertical playhead cursor + time tooltip
 *   - click / drag: seeks the audio to that position
 *   - the current playhead is drawn as a vertical gradient line
 *   - played portion uses the pink→blue gradient; unplayed is dim
 */
const PEAK_COUNT = 400

interface Peaks {
  min: Float32Array
  max: Float32Array
  duration: number
}

/**
 * Compute the peak envelope of an AudioBuffer. Returns min/max arrays
 * of length `PEAK_COUNT` (downsampled from the raw channel data).
 *
 * This is the standard "waveform overview" algorithm: split the
 * samples into N buckets, take the min and max of each bucket. Drawing
 * min-to-max as a vertical line gives the classic waveform shape.
 */
function computePeaks(buffer: AudioBuffer): Peaks {
  const channels = buffer.numberOfChannels
  const len = buffer.length
  const bucket = Math.max(1, Math.floor(len / PEAK_COUNT))
  const min = new Float32Array(PEAK_COUNT)
  const max = new Float32Array(PEAK_COUNT)
  // mix all channels together for the envelope
  const chanData: Float32Array[] = []
  for (let c = 0; c < channels; c++) chanData.push(buffer.getChannelData(c))
  for (let i = 0; i < PEAK_COUNT; i++) {
    const start = i * bucket
    const end = Math.min(len, start + bucket)
    let mn = 1, mx = -1
    for (let j = start; j < end; j++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += chanData[c][j]
      s /= channels
      if (s < mn) mn = s
      if (s > mx) mx = s
    }
    min[i] = mn
    max[i] = mx
  }
  return { min, max, duration: buffer.duration }
}

export function TrackWaveform() {
  const track = useSonicStore((s) => s.track)
  const player = useSonicStore((s) => s.player)
  const { seek, audio } = useEngines()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const peaksRef = useRef<Peaks | null>(null)

  // Compute peaks when a track loads. We need the raw AudioBuffer,
  // which lives on the AudioEngine (not in the store — too big).
  useEffect(() => {
    if (!track) {
      peaksRef.current = null
      return
    }
    const buf = audio.getBuffer()
    if (!buf) {
      peaksRef.current = null
      return
    }
    peaksRef.current = computePeaks(buf)
  }, [track, audio])

  // Draw loop — re-renders the waveform + playhead each frame
  useEffect(() => {
    if (!track) return
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const peaks = peaksRef.current
      // size the canvas to its CSS box (handles resize)
      const cssW = container.clientWidth
      const cssH = container.clientHeight
      if (canvas.width !== cssW || canvas.height !== cssH) {
        canvas.width = cssW
        canvas.height = cssH
      }
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      if (!peaks) {
        // no peaks yet — draw a flat line
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, h / 2)
        ctx.lineTo(w, h / 2)
        ctx.stroke()
        return
      }
      const mid = h / 2
      const amp = h * 0.45
      const n = peaks.min.length
      const colW = w / n
      // current playhead position
      const curT = audio.getCurrentTime()
      const playX = (curT / peaks.duration) * w

      // draw peak columns
      for (let i = 0; i < n; i++) {
        const x = i * colW
        const played = x <= playX
        const yTop = mid - peaks.max[i] * amp
        const yBot = mid - peaks.min[i] * amp
        const barH = Math.max(1, yBot - yTop)
        if (played) {
          // gradient pink→blue for played portion
          const t = i / n
          const r = Math.round(255 * (1 - t) + 45 * t)
          const g = Math.round(45 * (1 - t) + 155 * t)
          const b = Math.round(149 * (1 - t) + 255 * t)
          ctx.fillStyle = `rgba(${r},${g},${b},0.9)`
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.18)'
        }
        ctx.fillRect(x, yTop, Math.max(1, colW - 0.5), barH)
      }

      // playhead line
      ctx.fillStyle = '#fff'
      ctx.fillRect(playX - 0.5, 0, 1.5, h)
      // playhead glow
      const grad = ctx.createLinearGradient(playX - 6, 0, playX + 6, 0)
      grad.addColorStop(0, 'rgba(255,45,149,0)')
      grad.addColorStop(0.5, 'rgba(255,45,149,0.4)')
      grad.addColorStop(1, 'rgba(45,155,255,0)')
      ctx.fillStyle = grad
      ctx.fillRect(playX - 6, 0, 12, h)

      // hover cursor + tooltip
      if (hoverX !== null) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillRect(hoverX - 0.5, 0, 1, h)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [track, audio, hoverX])

  // pointer handlers — click/drag to seek
  const seekFromEvent = (clientX: number) => {
    const canvas = canvasRef.current
    const peaks = peaksRef.current
    if (!canvas || !peaks) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const t = (x / rect.width) * peaks.duration
    void seek(t)
    setHoverX(x)
    setHoverTime(t)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!track) return
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    seekFromEvent(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!track) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    setHoverX(x)
    const peaks = peaksRef.current
    if (peaks) setHoverTime((x / rect.width) * peaks.duration)
    if (dragging) seekFromEvent(e.clientX)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false)
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }
  const onPointerLeave = () => {
    setHoverX(null)
    setHoverTime(null)
  }

  const duration = track?.duration ?? 0

  // tooltip position (clamped so it doesn't overflow the container)
  const tooltipStyle = useMemo(() => {
    if (hoverX === null) return { display: 'none' }
    return {
      left: `${Math.max(28, Math.min(duration * 20 - 28, hoverX))}px`,
    } as React.CSSProperties
  }, [hoverX, duration])

  if (!track) return null

  return (
    <div
      ref={containerRef}
      className="relative h-10 flex-1 cursor-pointer select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      role="slider"
      aria-label="Seek through track waveform"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={player.currentTime}
      aria-valuetext={`${formatTime(player.currentTime)} of ${formatTime(duration)}`}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
      />
      {hoverTime !== null && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white shadow-lg"
          style={tooltipStyle}
        >
          {formatTime(hoverTime)}
        </div>
      )}
    </div>
  )
}
