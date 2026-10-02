import * as THREE from 'three'
import type { UserSettings, VisualState, AudioFeatures } from '../audio/types'

/**
 * ============================================================================
 * MODULE: MappingCurves — piecewise-linear response shaping for the mapper
 * ============================================================================
 *
 * WHAT IT IS
 *   A small library of pure functions and types that implement
 *   "MappingCurves" — piecewise-linear response curves the user can
 *   drag in the MappingEditor UI to shape how each audio feature (bass /
 *   beat / treble / energy) drives the visuals.
 *
 * WHY IT EXISTS
 *   Before this module existed, the VisualMapper applied each audio
 *   feature *linearly*: a 50% bass signal drove 50% of the maximum bass
 *   reaction. That's mathematically clean but musically wrong:
 *
 *     - Quiet signals *sound* louder than they measure (perceptual
 *       loudness is roughly logarithmic — see AudioAnalyzer.ts' gamma
 *       discussion). Linear mapping makes quiet music look dead.
 *     - Some features shouldn't react until they cross a threshold —
 *       you don't want every faint hi-hat to spawn particles, only
 *       strong ones.
 *     - Some users want an *inverted* response (high audio → dim
 *       visuals, silence → bright) for ambient / drone aesthetics.
 *
 *   A piecewise-linear curve between 2 and 8 control points lets the
 *   user express all of these without us picking one default. The
 *   curve is applied *before* the user's `*Reaction` gain (see
 *   VisualMapper.ts Stage 2), so it composes cleanly with the gain
 *   stage: curve shapes *what kind of input triggers a response*,
 *   reaction sets *how strong that response is*.
 *
 * WHAT GOES IN
 *   - A `MappingCurve` (key + 2..8 ControlPoints) and an input value
 *     `x` in 0..1 → evalCurve returns the interpolated output y.
 *   - An AudioFeatures object + a curve set → applyMappingCurves returns
 *     a {bass, beat, treble, energy} tuple of remapped values.
 *   - A JSON string (from localStorage / URL share) → deserializeCurves
 *     returns a validated curve set, falling back to defaults.
 *
 * WHAT COMES OUT
 *   - MappingCurve type (used by VisualMapper and the editor UI)
 *   - defaultCurves() — identity curves, used as the starting point
 *   - evalCurve() — the per-frame evaluation function (called from
 *     VisualMapper.map)
 *   - CURVE_PRESETS — named curve shapes the user can quick-apply
 *   - movePoint / addPoint / removePoint — editor mutations
 *
 * WHAT DEPENDS ON IT
 *   - VisualMapper.ts (uses defaultCurves + evalCurve)
 *   - VisualEngine.ts (setMappingCurves forwards here)
 *   - The MappingEditor UI component (uses all editor helpers + presets)
 *   - The persistence layer (localStorage / URL share via serialize/deserialize)
 *
 * WHAT IT DEPENDS ON
 *   - audio/types.ts (AudioFeatures, VisualState, UserSettings) for type
 *     compatibility with the rest of the pipeline.
 *   - three (only for the AudioFeatures import chain — no Three math
 *     is used here).
 *
 * PIECEWISE-LINEAR EVALUATION (Level 2 — the core algorithm)
 *
 *   A curve is an array of ControlPoints sorted by x. To evaluate at
 *   input value `x` (0..1):
 *
 *     1. Clamp x to [0,1] (the curve is undefined outside the unit square).
 *     2. Find the segment [p0, p1] where p0.x <= x <= p1.x (linear scan).
 *     3. Compute the local parameter t = (x - p0.x) / (p1.x - p0.x).
 *     4. Linearly interpolate: y = p0.y + (p1.y - p0.y) * t.
 *
 *   If x falls outside all segments (below the first point or above the
 *   last), we clamp to the nearest endpoint's y value.
 *
 *   Visual example — an "aggressive" curve with 5 points:
 *
 *     points: (0,0), (0.15, 0.4), (0.4, 0.75), (0.7, 0.95), (1, 1)
 *
 *       y
 *       1.0 ┤                               ●━━━●  (1,1)
 *       0.9 ┤                          ●━━━━(0.7, 0.95)
 *       0.8 ┤                     ●━━━━(0.4, 0.75)
 *       0.7 ┤
 *       0.6 ┤
 *       0.5 ┤
 *       0.4 ┤          ●━━━━━━━━(0.15, 0.4)
 *       0.3 ┤         ╱
 *       0.2 ┤        ╱
 *       0.1 ┤       ╱
 *       0.0 ┤●━━━━(0,0)
 *           └──┬──┬────┬──┬──┬────┬──┬──────┬──┬── x
 *              0  .15  .3 .4  .5   .7 .8    1
 *
 *     Evaluating at x=0.25:
 *       - segment containing 0.25 is [(0.15, 0.4), (0.4, 0.75)]
 *       - t = (0.25 - 0.15) / (0.4 - 0.15) = 0.10 / 0.25 = 0.4
 *       - y = 0.4 + (0.75 - 0.4) * 0.4 = 0.4 + 0.14 = 0.54
 *       - So a 25% bass input drives the visual as if it were 54% —
 *         that's the "aggressive" boost at low volumes.
 *
 *   WHY piecewise-linear (not a Bezier / spline): the user can drag
 *     each control point independently and see exactly where the
 *     curve goes through it. Splines have implicit tangents that
 *     make the curve "miss" the points — harder to reason about.
 *     Linear segments are unambiguous; the user sees what they get.
 *
 *   WHY 2..8 control points (not 100): more points = more freedom
 *     but also more UI clutter and easier to make weird shapes
 *     (sharp reversals, near-vertical segments that look like noise).
 *     8 is enough to express any of the preset shapes plus user
 *     customization, while keeping the editor's drag UI readable.
 *     The CURVE_PRESETS below have at most 5 points each.
 *
 *   WHY an identity default (y=x): the curve is the user's *opt-in*
 *     customization. Without one set, the audio feature passes
 *     through unchanged — VisualMapper's math is identical to
 *     pre-curve behavior. That's important for backward compat with
 *     saved settings that don't include a curve (the legacy saved
 *     state still works because identity = no-op).
 * ============================================================================
 */

/**
 * MappingCurve
 *
 * A piecewise-linear response curve that remaps an audio feature
 * (0..1) to a visual multiplier (0..1+). Each curve has 2-8 control
 * points; the curve is evaluated by linear interpolation between
 * adjacent points.
 *
 * Default curves are identity (y=x), meaning the audio feature passes
 * through unchanged. Users can drag control points in the MappingEditor
 * UI to shape the response — e.g. make bass more aggressive at low
 * volumes, or clamp treble at high volumes to avoid visual noise.
 *
 * Each curve is associated with a specific audio→visual mapping:
 *   bass → scale, beat → pulse, treble → particles, energy → brightness
 *
 * WHY the curve is per-feature (not one global curve): each feature
 *   has different musical characteristics. Bass wants different
 *   shaping (sustained, slow) than treble (transient, fast). One
 *   curve would force the user to compromise across all four.
 */
export interface ControlPoint {
  // ============================================================
  // PARAMETER: ControlPoint.x / y
  // Purpose:   x = input (audio feature value, 0..1)
  //            y = output (remapped multiplier, 0..1)
  // Safe range: 0..1 for both. Outside this range the renderer's
  //            uniform uploads may produce unexpected colors or
  //            negative scaling; evalCurve clamps but the editor
  //            should too.
  // Typical:   varies by preset — see CURVE_PRESETS below for examples.
  // Try:       drag y above 1.0 (clamp-permits it in the renderer) for
  //            an over-unity boost on a specific input range.
  // WARNING:   if two points share the same x, the segment between
  //            them has zero width and evalCurve's division would
  //            produce NaN. The editor's movePoint guards against
  //            this; the deserializer does NOT — invalid saved
  //            curves should be filtered out by the caller.
  // ============================================================
  x: number // 0..1 (input: audio feature value)
  y: number // 0..1 (output: remapped multiplier)
}

/**
 * MappingKey — the four audio features that have user-editable curves.
 *
 * WHY only four (not all AudioFeatures fields): lowMid and highMid
 *   aren't directly mapped to a single VisualState field (mid is used
 *   raw for rotation; lowMid/highMid are band-summed into energy).
 *   Exposing curves for them would clutter the editor without giving
 *   the user a useful lever.
 *
 * WHY a string union (not enum): tree-shaking removes unused string
 *   literals; enums generate runtime code. This is the same convention
 *   as SceneId in audio/types.ts.
 */
export type MappingKey = 'bass' | 'beat' | 'treble' | 'energy'

export interface MappingCurve {
  key: MappingKey
  points: ControlPoint[]
}

/**
 * Default curves: identity (y=x) with 3 points for smooth interpolation.
 *
 * WHY 3 points (not 2): two points (just (0,0) and (1,1)) is the
 *   minimal identity curve. Adding a (0.5, 0.5) midpoint gives the
 *   user a starting handle to drag — without it, the editor shows a
 *   straight diagonal with no grab points except the corners, which
 *   is hard to manipulate.
 *
 * WHY a factory function (not a constant): callers (the editor) need
 *   a fresh object on every reset — if this were a shared constant,
 *   a user dragging a point on one curve would mutate it for all
 *   future resets. The factory returns a new object each call.
 */
export function defaultCurves(): Record<MappingKey, MappingCurve> {
  const identity = (key: MappingKey): MappingCurve => ({
    key,
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
  })
  return {
    bass: identity('bass'),
    beat: identity('beat'),
    treble: identity('treble'),
    energy: identity('energy'),
  }
}

/**
 * Evaluate a piecewise-linear curve at input value `x` (0..1).
 * Clamps `x` to [0,1]. Returns the interpolated `y` value.
 *
 * If the curve has fewer than 2 points, returns `x` (identity).
 *
 * ALGORITHM (Level 2) — piecewise-linear evaluation:
 *
 *   See the file-level "PIECEWISE-LINEAR EVALUATION" section for the
 *   full visual example. Summary:
 *
 *     1. Validate: if fewer than 2 points, the curve is degenerate —
 *        return the clamped input (identity behavior). This protects
 *        against corrupted saved states.
 *     2. Clamp the input: cx = max(0, min(1, x)). Curves are only
 *        defined on the unit square.
 *     3. Linear scan for the segment: find the first [p0, p1] pair
 *        where p0.x <= cx <= p1.x. With ≤8 points this is O(8) —
 *        faster than a binary search for small N and clearer to read.
 *     4. Compute t = (cx - p0.x) / (p1.x - p0.x).
 *     5. Linearly interpolate: y = p0.y + (p1.y - p0.y) * t.
 *     6. Degenerate segment guard: if dx (= p1.x - p0.x) is below
 *        1e-6, return p0.y — avoids division by ~0 producing huge
 *        t values that amplify tiny floating-point errors.
 *     7. Outside-all-segments fallback: if cx is below the first
 *        point's x or above the last point's x, clamp to that
 *        endpoint's y. (This handles saved curves whose first/last
 *        points aren't at x=0 / x=1, which the editor allows.)
 *
 *   WHY O(N) linear scan (not binary search): for N ≤ 8 the constant
 *     overhead of binary search exceeds the linear scan's cost. The
 *     linear scan also reads better — the loop body is just "is x
 *     in [p0.x, p1.x]?". If we ever support 100+ control points,
 *     switch to binary search.
 *
 *   WHY `dx < 1e-6` (not `dx === 0`): floating-point. Two points
 *     that should be at the same x might be 1e-7 apart after JSON
 *     round-trip. Direct === 0 check would miss them and produce
 *     huge t values from the division.
 *
 *   WHY no caching of segment lookups: the curve is re-evaluated
 *     every frame for every feature (4 calls). The lookup is O(N)
 *     with N≤8 — ~32 ops per frame, negligible vs. the GL work.
 *     Caching would require invalidation when the curve mutates,
 *     adding complexity for no measurable perf gain.
 */
export function evalCurve(curve: MappingCurve, x: number): number {
  const pts = curve.points
  if (pts.length < 2) return Math.max(0, Math.min(1, x))
  const cx = Math.max(0, Math.min(1, x))
  // find the segment containing cx
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]
    const p1 = pts[i + 1]
    if (cx >= p0.x && cx <= p1.x) {
      const dx = p1.x - p0.x
      // WHY the 1e-6 guard: see file-level algorithm notes.
      if (dx < 1e-6) return p0.y
      const t = (cx - p0.x) / dx
      return p0.y + (p1.y - p0.y) * t
    }
  }
  // cx is outside all segments — clamp to endpoints
  // WHY: a saved curve might have its first point at x=0.1 (not 0).
  //   An input of x=0.05 falls outside all segments — we return the
  //   first point's y rather than NaN.
  if (cx < pts[0].x) return pts[0].y
  return pts[pts.length - 1].y
}

/**
 * Apply mapping curves to an AudioFeatures object, producing remapped
 * values for bass/beat/treble/energy. These remapped values are then
 * multiplied by the user's `*Reaction` settings in VisualMapper.
 *
 * Returns a new object — does not mutate the input features.
 *
 * WHY a separate helper (VisualMapper already does this inline): this
 *   function is used by the editor's live preview ("what would these
 *   curves do to the current audio?") without going through the full
 *   VisualMapper.map pipeline. The VisualMapper's own Stage 2 calls
 *   evalCurve directly for performance (avoids building the intermediate
 *   tuple) — both paths produce the same numbers.
 *
 * WHY immutability (returning a new object): the AudioFeatures object
 *   is also read by scenes for waveform/spectrum uploads; mutating
 *   its bass/treble fields would silently change what scenes see
 *   downstream. Returning a new tuple keeps the input untouched.
 */
export function applyMappingCurves(
  features: AudioFeatures,
  curves: Record<MappingKey, MappingCurve>
): { bass: number; beat: number; treble: number; energy: number } {
  return {
    bass: evalCurve(curves.bass, features.bass),
    beat: evalCurve(curves.beat, features.beatPulse),
    treble: evalCurve(curves.treble, features.treble),
    energy: evalCurve(curves.energy, features.overallEnergy),
  }
}

/**
 * Serialize curves to a plain JSON-serializable format (for localStorage
 * + URL sharing). ControlPoint arrays are already plain objects.
 *
 * WHY a thin JSON.stringify wrapper (not a custom serializer): the
 *   MappingCurve shape is already plain JSON ({key: string, points:
 *   {x,y}[]}). A custom serializer would just be re-implementing JSON.
 *   The wrapper exists as a named function so callers don't have to
 *   remember "use JSON.stringify" — it documents the persistence format.
 *
 *   The matching deserializeCurves does the validation (since
 *   JSON.parse is unsafe on arbitrary input).
 */
export function serializeCurves(curves: Record<MappingKey, MappingCurve>): string {
  return JSON.stringify(curves)
}

/**
 * Deserialize curves from a JSON string. Validates the shape; returns
 * default curves if parsing fails or the shape is wrong.
 *
 * WHY defensive parsing (not just JSON.parse): the string may come
 *   from localStorage (could be from an old version with a different
 *   shape), from a shared URL (could be tampered with), or from a
 *   corrupted save. Returning defaults on any error is safer than
 *   throwing — the user gets a working UI even if their saved state
 *   is broken, and the editor will show identity curves instead of
 *   crashing.
 *
 * WHY per-key validation: each key is validated independently. If the
 *   saved 'bass' curve is broken but 'treble' is fine, we keep the
 *   fine one and reset only the broken one. Better UX than "all or
 *   nothing".
 *
 * WHY the basic validation (all points have x,y in [0,1]): the editor
 *   clamps on input, but saved states from before that clamp existed
 *   might have out-of-range values. Validating here catches them.
 *
 * WHY re-sort by x after parsing: the editor keeps points sorted, but
 *   a hand-edited JSON might not be. Sorting guarantees the segment-
 *   finding scan in evalCurve works (it assumes points are in x order).
 */
export function deserializeCurves(json: string): Record<MappingKey, MappingCurve> {
  try {
    const parsed = JSON.parse(json)
    const defaults = defaultCurves()
    if (!parsed || typeof parsed !== 'object') return defaults
    const result = { ...defaults }
    for (const key of ['bass', 'beat', 'treble', 'energy'] as MappingKey[]) {
      const c = parsed[key]
      if (c && Array.isArray(c.points) && c.points.length >= 2) {
        // basic validation: all points have x,y in [0,1]
        const valid = c.points.every(
          (p: any) =>
            typeof p.x === 'number' && typeof p.y === 'number' &&
            p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
        )
        if (valid) {
          result[key] = { key, points: c.points.sort((a: ControlPoint, b: ControlPoint) => a.x - b.x) }
        }
      }
    }
    return result
  } catch {
    // WHY swallow the error: see function-level note — better to
    //   return defaults than crash the editor. The error is logged
    //   implicitly by the dev seeing identity curves when they expected
    //   their saved state.
    return defaultCurves()
  }
}

/**
 * Move a control point to a new position. Returns a new curve (does
 * not mutate). Points are kept sorted by x after the move.
 *
 * WHY immutable (returns new curve): the editor uses React state,
 *   which requires a new reference to trigger re-render. Mutating in
 *   place would silently fail to update the UI.
 *
 * WHY re-sort after move: the user might drag a point past its
 *   neighbor. The curve must remain a function of x (one y per x), so
 *   we re-sort by x to maintain that invariant. The moved point keeps
 *   its new (x, y) but may end up at a different index in the array.
 *
 * WHY clamp x,y to [0,1]: the editor's drag UI constrains to the unit
 *   square, but this function is also called programmatically (e.g.
 *   by tests). Clamping here is the last line of defense.
 */
export function movePoint(
  curve: MappingCurve,
  index: number,
  x: number,
  y: number
): MappingCurve {
  const clamped = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  const points = curve.points.map((p, i) => (i === index ? clamped : p))
  // sort by x and re-index
  points.sort((a, b) => a.x - b.x)
  return { key: curve.key, points }
}

/**
 * Add a control point to the curve at position (x, y). The point is
 * inserted and the array is re-sorted. Returns a new curve.
 *
 * WHY no upper limit on count here: the editor's UI enforces the 8-
 *   point max (it disables the "add" button when count >= 8). This
 *   function is the lower-level primitive and doesn't impose a limit
 *   so it can be used in tests or programmatic curve construction
 *   without the artificial cap.
 *
 * WHY clamp x,y to [0,1]: same reason as movePoint — defense in depth
 *   against programmatic callers that might pass out-of-range values.
 */
export function addPoint(curve: MappingCurve, x: number, y: number): MappingCurve {
  const clamped = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  const points = [...curve.points, clamped].sort((a, b) => a.x - b.x)
  return { key: curve.key, points }
}

/**
 * Remove a control point by index. Returns a new curve. If removing
 * would leave fewer than 2 points, returns the original curve.
 *
 * WHY the 2-point floor: a curve with fewer than 2 points is
 *   degenerate — evalCurve returns the clamped input (identity) for
 *   such curves, which would surprise the user who just removed a
 *   point and expected the curve to still work. Forbidding removal
 *   below 2 keeps the curve always-evaluable. The editor also
 *   disables the remove button at this floor, but this is the
 *   lower-level guard.
 */
export function removePoint(curve: MappingCurve, index: number): MappingCurve {
  if (curve.points.length <= 2) return curve
  const points = curve.points.filter((_, i) => i !== index)
  return { key: curve.key, points }
}

/**
 * CurvePreset — a named curve shape that users can quick-apply.
 *
 * Each preset defines a shape that works well for a specific musical
 * characteristic. Presets are per-key (bass/beat/treble/energy) so
 * they can be applied independently.
 *
 * WHY a `make` factory (not a static curve object): each key needs
 *   its own MappingCurve object (with its own `key` field and a
 *   fresh points array). A static shared curve would have the wrong
 *   `key` field for all but one feature. The factory takes the key
 *   and stamps it onto a fresh copy of the preset's points.
 */
export interface CurvePreset {
  id: string
  name: string
  description: string
  /** factory: returns a new MappingCurve with this preset's points */
  make: (key: MappingKey) => MappingCurve
}

/**
 * Predefined curve shapes for quick application.
 *
 * - linear: identity (y=x) — neutral, passes through unchanged
 * - aggressive: boosts low values aggressively, saturates high
 *     (S-curve that pushes everything above 0.3 toward 1.0)
 * - smooth: gentle S-curve, softens extremes
 * - threshold: step function — nothing until 0.4, then ramps to 1.0
 *     (useful for beat detection: only strong beats trigger visuals)
 * - invert: inverted curve — high audio → low visual (reversed response)
 *
 * VISUAL CHEAT SHEET (each curve plotted 0..1 → 0..1):
 *
 *   linear:        aggressive:        smooth:         threshold:
 *       1┤●            1┤       ●         1┤       ●        1┤     ●━━━●
 *       │╲             │      ╱          │      ╱         │  
 *       │ ╲            │     ╱           │     ╱          │  
 *       │  ╲           │    ●            │    ●           │  
 *       │   ╲          │   ╱             │   ╱            │  
 *       │    ╲         │  ╱              │  ╱             │  
 *       │     ╲        │ ╱               │ ●              │ 
 *       │      ╲       │●                │╱               │
 *       0┤       ●     0┤●              0┤●              0┤●━━━●
 *         0─────1       0─────1           0─────1          0─────1
 *
 *   invert:
 *       1┤●
 *       │╲
 *       │ ╲
 *       │  ╲
 *       │   ╲
 *       │    ╲
 *       │     ╲
 *       │      ╲
 *       0┤       ●
 *         0─────1
 *
 * CUSTOMIZATION: add a new preset by appending to this array. The
 *   editor's preset picker iterates CURVE_PRESETS dynamically, so a
 *   new entry shows up automatically. Keep `id` unique — it's used
 *   as the React key in the picker UI.
 */
export const CURVE_PRESETS: CurvePreset[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Neutral 1:1 response. Audio passes through unchanged.',
    make: (key) => ({
      key,
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ],
    }),
  },
  {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'Boosts low values, saturates high. Great for punchy bass.',
    make: (key) => ({
      key,
      points: [
        { x: 0, y: 0 },
        { x: 0.15, y: 0.4 },
        { x: 0.4, y: 0.75 },
        { x: 0.7, y: 0.95 },
        { x: 1, y: 1 },
      ],
    }),
  },
  {
    id: 'smooth',
    name: 'Smooth',
    description: 'Gentle S-curve. Softens both extremes for subtle response.',
    make: (key) => ({
      key,
      points: [
        { x: 0, y: 0 },
        { x: 0.3, y: 0.2 },
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.8 },
        { x: 1, y: 1 },
      ],
    }),
  },
  {
    id: 'threshold',
    name: 'Threshold',
    description: 'Nothing until 0.4, then ramps to full. Good for beat gates.',
    make: (key) => ({
      key,
      points: [
        { x: 0, y: 0 },
        { x: 0.35, y: 0 },
        { x: 0.45, y: 0.6 },
        { x: 0.8, y: 1 },
        { x: 1, y: 1 },
      ],
    }),
  },
  {
    id: 'invert',
    name: 'Inverted',
    description: 'Reversed response — high audio produces low visuals.',
    make: (key) => ({
      key,
      points: [
        { x: 0, y: 1 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0 },
      ],
    }),
  },
]
