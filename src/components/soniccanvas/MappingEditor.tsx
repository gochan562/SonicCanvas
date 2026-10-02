'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Activity, RotateCcw, ClipboardCopy, ClipboardPaste } from 'lucide-react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import {
  type MappingCurve,
  type MappingKey,
  type CurvePreset,
  defaultCurves,
  movePoint,
  addPoint,
  removePoint,
  evalCurve,
  serializeCurves,
  deserializeCurves,
  CURVE_PRESETS,
} from '@/lib/soniccanvas/visuals/MappingCurves'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

/**
 * Compute the sum-of-squared-differences between a curve and a preset
 * across 20 sample points. Lower = closer. Used by the "closest
 * preset" indicator to show which preset the current curve most
 * resembles.
 */
function curveDistance(a: MappingCurve, b: MappingCurve): number {
  let sum = 0
  for (let i = 0; i <= 20; i++) {
    const x = i / 20
    const ya = evalCurve(a, x)
    const yb = evalCurve(b, x)
    sum += (ya - yb) * (ya - yb)
  }
  return sum
}

/**
 * Find the CURVE_PRESETS entry whose shape is closest to the given
 * curve. Returns `{ preset, distance }` or null if no presets.
 */
function findClosestPreset(curve: MappingCurve): { preset: CurvePreset; distance: number } | null {
  let best: CurvePreset | null = null
  let bestDist = Infinity
  for (const p of CURVE_PRESETS) {
    const candidate = p.make(curve.key)
    const d = curveDistance(curve, candidate)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  return best ? { preset: best, distance: bestDist } : null
}

/**
 * MappingEditor (spec §46 — mapping editor)
 *
 * A visual curve editor for the 4 audio→visual mapping curves
 * (bass/beat/treble/energy). Each curve is a piecewise-linear
 * function that remaps an audio feature value (0..1) to a multiplier
 * (0..1) before it's multiplied by the user's `*Reaction` amount.
 *
 * The editor shows a single curve at a time (selectable via tabs).
 * The user can:
 *   - drag any control point to reshape the curve
 *   - click on empty canvas to add a new control point
 *   - right-click a point to remove it (minimum 2 points)
 *   - press "Reset" to restore the identity curve
 *
 * A live "current value" indicator dot moves along the curve as the
 * audio features change, showing where the current audio level maps to.
 */

const CURVE_COLORS: Record<MappingKey, string> = {
  bass: '#ff2d95',
  beat: '#f59e0b',
  treble: '#2d9bff',
  energy: '#10b981',
}

const CURVE_LABELS: Record<MappingKey, string> = {
  bass: 'Bass',
  beat: 'Beat',
  treble: 'Treble',
  energy: 'Energy',
}

const CANVAS_SIZE = 240

interface CurveCanvasProps {
  curveKey: MappingKey
  curve: MappingCurve
  onChange: (key: MappingKey, curve: MappingCurve) => void
}

function CurveCanvas({ curveKey, curve, onChange }: CurveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const color = CURVE_COLORS[curveKey]

  // Draw the curve + control points + live value indicator
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo((w / 4) * i, 0)
      ctx.lineTo((w / 4) * i, h)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, (h / 4) * i)
      ctx.lineTo(w, (h / 4) * i)
      ctx.stroke()
    }
    // identity line (dashed)
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.beginPath()
    ctx.moveTo(0, h)
    ctx.lineTo(w, 0)
    ctx.stroke()
    ctx.setLineDash([])

    // curve fill (under the curve)
    const pts = curve.points
    ctx.fillStyle = color + '15' // 15 = ~8% alpha
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const p of pts) {
      ctx.lineTo(p.x * w, h - p.y * h)
    }
    ctx.lineTo(pts[pts.length - 1].x * w, h)
    ctx.closePath()
    ctx.fill()

    // curve line
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x * w
      const py = h - pts[i].y * h
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()

    // live value indicator
    const visual = (window as any).__sonicVisual
    const f = visual?.getLatestFeatures?.()
    if (f) {
      const raw = curveKey === 'beat' ? f.beatPulse : curveKey === 'bass' ? f.bass : curveKey === 'treble' ? f.treble : f.overallEnergy
      // find the y on the curve at this x
      let cy = raw
      for (let i = 0; i < pts.length - 1; i++) {
        if (raw >= pts[i].x && raw <= pts[i + 1].x) {
          const dx = pts[i + 1].x - pts[i].x
          if (dx > 1e-6) {
            const t = (raw - pts[i].x) / dx
            cy = pts[i].y + (pts[i + 1].y - pts[i].y) * t
          }
          break
        }
      }
      const cx = raw * w
      const cyp = h - cy * h
      // vertical line
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, h)
      ctx.stroke()
      ctx.setLineDash([])
      // dot on curve
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(cx, cyp, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cyp, 6, 0, Math.PI * 2)
      ctx.stroke()
    }

    // control points
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x * w
      const py = h - pts[i].y * h
      const isHover = hoverIdx === i || dragIdx === i
      const r = isHover ? 6 : 4
      ctx.fillStyle = isHover ? color : '#fff'
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, r + 1, 0, Math.PI * 2)
      ctx.stroke()
    }
  }, [curve, color, curveKey, dragIdx, hoverIdx])

  // rAF draw loop
  useEffect(() => {
    let raf = 0
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  // pointer → canvas coordinates
  const toCanvas = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = 1 - (e.clientY - rect.top) / rect.height
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  }

  // find nearest control point within a threshold
  const findPoint = (x: number, y: number): number => {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < curve.points.length; i++) {
      const dx = curve.points[i].x - x
      const dy = curve.points[i].y - y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < bestDist && dist < 0.08) {
        bestDist = dist
        best = i
      }
    }
    return best
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toCanvas(e)
    const idx = findPoint(x, y)
    if (idx >= 0) {
      setDragIdx(idx)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } else {
      // add a new point
      const newCurve = addPoint(curve, x, y)
      onChange(curveKey, newCurve)
      // start dragging the new point (last one closest to click)
      const newIdx = newCurve.points.findIndex(
        (p) => Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01
      )
      if (newIdx >= 0) {
        setDragIdx(newIdx)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = toCanvas(e)
    if (dragIdx !== null) {
      const newCurve = movePoint(curve, dragIdx, x, y)
      onChange(curveKey, newCurve)
    } else {
      setHoverIdx(findPoint(x, y))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    setDragIdx(null)
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = toCanvas(e as unknown as React.PointerEvent)
    const idx = findPoint(x, y)
    if (idx >= 0 && curve.points.length > 2) {
      const newCurve = removePoint(curve, idx)
      onChange(curveKey, newCurve)
    }
  }

  return (
    <div className="space-y-1.5">
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="sonc-curve-canvas w-full rounded-lg border border-white/10 bg-black/40"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverIdx(null)}
        onContextMenu={onContextMenu}
        role="img"
        aria-label={`${CURVE_LABELS[curveKey]} response curve editor — drag points to reshape, click to add, right-click to remove`}
      />
      <div className="flex items-center justify-between text-[10px] text-white/40">
        <span>Audio level →</span>
        <span>Visual response →</span>
      </div>
    </div>
  )
}

export function MappingEditor() {
  const mappingCurves = useSonicStore((s) => s.mappingCurves)
  const setMappingCurve = useSonicStore((s) => s.setMappingCurve)
  const soloFeature = useSonicStore((s) => s.soloFeature)
  const [activeKey, setActiveKey] = useState<MappingKey>('bass')

  const handleReset = () => {
    const defaults = defaultCurves()
    useSonicStore.getState().setMappingCurves(defaults)
    toast({ title: 'Curves reset', description: 'All mapping curves restored to identity.' })
  }

  const handleExport = async () => {
    const json = serializeCurves(mappingCurves)
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(json)
      } else {
        const ta = document.createElement('textarea')
        ta.value = json
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      toast({ title: 'Curves copied', description: 'JSON copied to clipboard. Paste it elsewhere to share.' })
    } catch {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' })
    }
  }

  const handleImport = async () => {
    try {
      const text = navigator.clipboard
        ? await navigator.clipboard.readText()
        : prompt('Paste curve JSON here:') || ''
      if (!text) {
        toast({ title: 'Nothing to import', description: 'Clipboard is empty.' })
        return
      }
      const parsed = deserializeCurves(text)
      useSonicStore.getState().setMappingCurves(parsed)
      toast({ title: 'Curves imported', description: 'Mapping curves loaded from clipboard.' })
    } catch {
      toast({ title: 'Import failed', description: 'Could not read clipboard or invalid JSON.', variant: 'destructive' })
    }
  }

  return (
    <Card className="sonic-card-hover border-white/10 bg-white/[0.02] text-white backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-[#ff2d95]" />
            Mapping Editor
          </CardTitle>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleExport}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/60 transition-colors hover:border-[#2d9bff]/40 hover:text-white"
              title="Copy all curves as JSON to clipboard"
            >
              <ClipboardCopy className="h-2.5 w-2.5" />
              Export
            </button>
            <button
              type="button"
              onClick={handleImport}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/60 transition-colors hover:border-[#10b981]/40 hover:text-white"
              title="Import curves from clipboard JSON"
            >
              <ClipboardPaste className="h-2.5 w-2.5" />
              Import
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-white/50 hover:text-white"
              onClick={handleReset}
              title="Reset all curves to identity"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>
        </div>
        <CardDescription className="text-xs text-white/40">
          Shape how audio features map to visuals. Drag points, click to add, right-click to remove.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Curve selector tabs + solo buttons */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-4 gap-1">
            {(['bass', 'beat', 'treble', 'energy'] as MappingKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveKey(key)}
                className={[
                  'rounded-md border px-2 py-1.5 text-[10px] font-medium transition-all',
                  activeKey === key
                    ? 'border-transparent text-white shadow-md'
                    : 'border-white/10 bg-black/30 text-white/60 hover:border-white/30 hover:text-white/90',
                ].join(' ')}
                style={
                  activeKey === key
                    ? { background: `linear-gradient(135deg, ${CURVE_COLORS[key]}40, ${CURVE_COLORS[key]}20)`, borderColor: CURVE_COLORS[key] + '60' }
                    : undefined
                }
                aria-pressed={activeKey === key}
              >
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                  style={{ background: CURVE_COLORS[key] }}
                />
                {CURVE_LABELS[key]}
              </button>
            ))}
          </div>
          {/* Solo mode row */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase tracking-wider text-white/30">Solo:</span>
            {(['bass', 'beat', 'treble', 'energy'] as MappingKey[]).map((key) => {
              const isSolo = soloFeature === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => useSonicStore.getState().setSoloFeature(isSolo ? null : key)}
                  className={[
                    'rounded px-1.5 py-0.5 text-[9px] font-medium transition-all',
                    isSolo
                      ? 'text-white shadow-md'
                      : 'text-white/40 hover:text-white/70',
                  ].join(' ')}
                  style={
                    isSolo
                      ? { background: CURVE_COLORS[key], boxShadow: `0 0 8px ${CURVE_COLORS[key]}60` }
                      : { background: 'rgba(255,255,255,0.05)' }
                  }
                  aria-pressed={isSolo}
                  title={`Solo ${CURVE_LABELS[key]} — isolate this feature's effect on visuals`}
                >
                  {CURVE_LABELS[key][0]}
                </button>
              )
            })}
            {soloFeature && (
              <button
                type="button"
                onClick={() => useSonicStore.getState().setSoloFeature(null)}
                className="ml-1 text-[9px] text-white/40 underline hover:text-white/70"
              >
                clear
              </button>
            )}
          </div>
        </div>
        {/* Curve canvas */}
        <CurveCanvas
          curveKey={activeKey}
          curve={mappingCurves[activeKey]}
          onChange={setMappingCurve}
        />
        {/* Closest-preset indicator */}
        {(() => {
          const closest = findClosestPreset(mappingCurves[activeKey])
          if (!closest) return null
          const isExact = closest.distance < 0.001
          return (
            <div className="flex items-center justify-center gap-1.5 text-[10px] text-white/40">
              <span>Shape:</span>
              <span
                className="font-medium"
                style={{ color: isExact ? '#10b981' : CURVE_COLORS[activeKey] }}
              >
                {isExact ? '✓ ' : '~ '}
                {closest.preset.name}
              </span>
              {!isExact && (
                <span className="text-white/25">
                  ({Math.round((1 - Math.min(1, closest.distance)) * 100)}% match)
                </span>
              )}
            </div>
          )
        })()}
        {/* Curve preset quick-select */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">
            Quick shapes
          </span>
          <div className="flex flex-wrap gap-1">
            {CURVE_PRESETS.map((preset) => {
              const closest = findClosestPreset(mappingCurves[activeKey])
              const isActive = closest?.preset.id === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setMappingCurve(activeKey, preset.make(activeKey))}
                  title={preset.description}
                  className={[
                    'sonc-preset-btn group flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-all',
                    isActive
                      ? 'border-[#ff2d95]/50 bg-[#ff2d95]/10 text-white'
                      : 'border-white/10 bg-black/30 text-white/60 hover:border-[#ff2d95]/40 hover:text-white',
                  ].join(' ')}
                >
                  <PresetMiniIcon preset={preset} color={CURVE_COLORS[activeKey]} />
                  <span>{preset.name}</span>
                </button>
              )
            })}
          </div>
        </div>
        <p className="text-[10px] leading-tight text-white/35">
          The white dot shows where the current audio level maps to. Drag points, click to add, right-click to remove.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * PresetMiniIcon — a tiny inline SVG preview of the preset's curve shape.
 * Renders the control points as a small (16×16) sparkline.
 */
function PresetMiniIcon({ preset, color }: { preset: CurvePreset; color: string }) {
  const curve = preset.make('bass') // key doesn't matter for the shape preview
  const pts = curve.points
  const w = 16
  const h = 16
  const d = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x * w).toFixed(1)} ${(h - p.y * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-3 w-3" fill="none" aria-hidden="true">
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
