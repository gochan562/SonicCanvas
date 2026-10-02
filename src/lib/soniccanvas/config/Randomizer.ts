import * as THREE from 'three'
import type { UserSettings, SceneId } from '../audio/types'
import type { MappingCurve, MappingKey } from '../visuals/MappingCurves'
import { defaultCurves } from '../visuals/MappingCurves'

/**
 * ============================================================================
 * MODULE: config/Randomizer.ts — one-click "surprise me" settings generator
 * ============================================================================
 *
 * WHAT IT IS
 *   A pure utility that returns a complete, visually-pleasing random
 *   UserSettings + mappingCurves pair. The user clicks a "🎲 Randomize"
 *   button (in the ControlsPanel advanced accordion); the store applies
 *   the returned settings; the renderer immediately re-paints with them.
 *
 * WHY IT EXISTS
 *   The slider surface in spec §22 is large (13 fields × safe ranges).
 *   Hand-tuning 13 sliders to find a new look is tedious. The randomizer
 *   trades *control* for *discovery*: it samples from constrained
 *   distributions that almost always look good, so users can click
 *   repeatedly until they find something they like, then fine-tune.
 *
 * WHY constrained random (not uniform random):
 *   Uniform sampling of each slider's safe range produces:
 *     - muddy dark colors (low saturation + low lightness)
 *     - blown-out white colors (high saturation + high lightness)
 *     - flat visuals (intensity near 0)
 *     - white-clipped visuals (intensity near 3)
 *     - jumpy curves that flicker frame-to-frame
 *   Each of these is *visually broken*. We avoid them by:
 *     - Sampling colors in HSL space (not RGB) with constrained S/L.
 *     - Sampling numerics in the middle 60-80% of their safe range.
 *     - Constraining mapping curve control points to wander near the
 *       identity line (a small jitter around the diagonal).
 *
 * WHAT GOES IN
 *   - The current UserSettings (only used to satisfy the type signature;
 *     none of its fields are read — the output is fully random).
 *
 * WHAT COMES OUT
 *   - `RandomizedSettings` = { settings: UserSettings, mappingCurves }.
 *     The caller (store action `randomize`) is responsible for applying
 *     them to the live store state.
 *
 * WHAT DEPENDS ON IT
 *   - ui/store.ts (calls `randomizeSettings` from the `randomize` action).
 *   - components/soniccanvas/ControlsPanel.tsx (binds the button to it).
 *
 * WHAT IT DEPENDS ON
 *   - `three` (for THREE.Color).
 *   - `../audio/types` (UserSettings, SceneId contracts).
 *   - `../visuals/MappingCurves` (MappingCurve, MappingKey).
 *
 * CUSTOMIZATION:
 *   - Widen or narrow the `rand(a, b)` ranges below to bias the
 *     randomizer toward wilder or tamer looks.
 *   - Replace `vibrantColor()` with `pastelColor()` (raise lightness, lower
 *     saturation) for a softer aesthetic.
 *   - Add a `chaos` parameter (0..1) that scales all jitter amplitudes.
 *
 * WARNING:
 *   - This module uses Math.random() directly. It is non-deterministic —
 *     same input does NOT produce same output. Don't use it for tests
 *     that need reproducibility; seed a PRNG there instead.
 *   - It does NOT randomize the active scene or preset — those stay as
 *     the user picked them. Only the *visual parameters* are randomized.
 * ============================================================================
 */

/**
 * Random float in [min, max).
 *
 * Level 3 SAFE PARAMETER helper: every numeric random range below goes
 * through this. If you want a deterministic test randomizer, mock this.
 */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * Random integer in [min, max] inclusive.
 *
 * The +1 in `rand(min, max + 1)` accounts for the half-open upper bound
 * of `rand` — without it the max value would never be sampled.
 */
function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1))
}

/**
 * ============================================================================
 * LEVEL 2 ALGORITHM — HSL color generation for "vibrant but not blown out"
 * ============================================================================
 *
 * Random colors are generated in HSL (Hue / Saturation / Lightness) space,
 * then converted to RGB internally by THREE.Color.setHSL. This is the
 * classic trick for procedural art (see Inigo Quilez's "palette"
 * articles and the processing `colorMode(HSB, ...)` convention).
 *
 * WHY HSL (not RGB):
 *   - RGB has no notion of "vibrant". A random RGB triple is likely to
 *     land on a muddy brown or a near-grey. The visual range of "vibrant"
 *     colors in RGB is a small skewed subset of the cube.
 *   - HSL separates *which color* (H, 0..360°) from *how colorful* (S)
 *     from *how bright* (L). We can independently pin S and L to
 *     pleasing ranges and let H roam freely — every result is colorful.
 *
 * THE THREE KNOBS WE USE
 *   - Hue:        uniform in [0°, 360°). Every hue is sampled equally.
 *                 No bias toward warm/cool. THREE.Color.setHSL takes H
 *                 normalized to [0, 1] (so we divide by 360).
 *   - Saturation: uniform in [0.6, 1.0]. 0.6 = rich but not neon;
 *                 1.0 = full saturation. Avoids grey/muddy results.
 *   - Lightness:  uniform in [0.45, 0.65]. 0.5 = pure hue; <0.45 = muddy
 *                 and dark on a dark background; >0.65 = bleached
 *                 toward white. 0.45-0.65 is the "visibly colored" band.
 *
 * WHY the bands were chosen:
 *   - 0.45-0.65 lightness range: above 0.65 the colors start to look
 *     pastel-washed against the dark `#05030d` background; below 0.45
 *     they're hard to distinguish from the background itself.
 *   - 0.6 saturation floor: 0.5 is where colors start to feel "off-grey";
 *     0.6 is the threshold where the human eye reliably reads the color
 *     as "a color" rather than "a tinted grey".
 *
 * CUSTOMIZATION:
 *   - For a pastel look, lower saturation to [0.3, 0.6] and raise
 *     lightness to [0.65, 0.85].
 *   - For a single-hue palette (e.g. all reds), narrow hue to [350°, 10°]
 *     (wrapping through 0).
 *   - For a complementary-pair palette, generate H and H+180°.
 * ============================================================================
 */
function vibrantColor(): THREE.Color {
  // H normalized to 0..1 (THREE.Color.setHSL takes 0..1, not 0..360).
  const h = rand(0, 360) / 360
  // S in the "visibly colored" band — avoids muddy greys.
  const s = rand(0.6, 1.0)
  // L in the "visible on dark background" band — avoids both mud and bleach.
  const l = rand(0.45, 0.65)
  const c = new THREE.Color()
  c.setHSL(h, s, l)
  return c
}

/**
 * A dark background color — very low lightness, any hue.
 *
 * WHY a tinted black (not pure #000000):
 *   - Pure black makes the crossfade base look flat. A subtle hue tint
 *     (saturation 0.3-0.7, lightness 0.02-0.08) gives the background a
 *     mood that complements the foreground without competing with it.
 *   - Lightness floor of 0.02 (not 0) keeps the canvas non-zero so shader
 *     additive blends have somewhere to add to (avoids weird "black on
 *     black" regions in LiquidScene's vignette).
 *
 * Level 3 SAFE PARAMETER: lightness range [0.02, 0.08]. Outside this
 *   range you get either pitch black (loses the tint) or grey (competes
 *   with the foreground).
 */
function darkBackground(): THREE.Color {
  const h = rand(0, 360) / 360
  const s = rand(0.3, 0.7)
  const l = rand(0.02, 0.08) // very dark, but not pitch-black
  const c = new THREE.Color()
  c.setHSL(h, s, l)
  return c
}

/**
 * Generate a random-but-pleasing mapping curve.
 * Produces 3-5 control points. The curve starts at (0,0) and ends
 * at (1,1), with intermediate points that wander but stay within
 * a "reasonable" band (no extreme jumps).
 *
 * WHY constrained wander (not free random points):
 *   - MappingCurves are piecewise-linear; arbitrary control points
 *     produce arbitrary jagged curves that flicker frame-to-frame as
 *     audio levels hover at a control point's x.
 *   - The classic "good" curve sits close to the identity line with
 *     small excursions — like a gamma curve (concave-up for "make
 *     quiet inputs visible", concave-down for "make loud inputs
 *     saturate").
 *   - We approximate this by jittering points around the identity y=x
 *     with ±0.25 amplitude, while keeping x near evenly-spaced positions.
 *
 * Level 3 SAFE PARAMETER: the ±0.25 wander amplitude. Larger values
 *   produce glitchy curves; smaller values produce curves too close
 *   to identity to be visually different from the default.
 */
function randomCurve(key: MappingKey): MappingCurve {
  // 3-5 points: 2 fixed endpoints + 1-3 interior control points.
  const n = randInt(3, 5)
  const points: { x: number; y: number }[] = []
  // First point pinned to (0, 0) so silence → no reaction.
  points.push({ x: 0, y: 0 })
  for (let i = 1; i < n - 1; i++) {
    // x near evenly-spaced (i / (n-1)) with ±0.08 jitter to avoid
    // having two points land on the same x (which would degenerate the
    // piecewise-linear interpolation).
    const x = i / (n - 1) + rand(-0.08, 0.08) // jitter around even spacing
    // y near identity with ±0.25 wander. Clamped to [0, 1] so the
    // curve never goes below silence or above saturation.
    const y = x + rand(-0.25, 0.25) // wander near identity
    points.push({
      x: Math.max(0.01, Math.min(0.99, x)),
      y: Math.max(0, Math.min(1, y)),
    })
  }
  // Last point pinned to (1, 1) so full audio → full reaction.
  points.push({ x: 1, y: 1 })
  // sort by x — random jitter may have placed points out of order, and
  // the piecewise-linear evaluator requires monotonically-increasing x.
  points.sort((a, b) => a.x - b.x)
  return { key, points }
}

export interface RandomizedSettings {
  settings: UserSettings
  mappingCurves: Record<MappingKey, MappingCurve>
}

/**
 * Generate a complete random-but-coherent set of visual settings.
 * The caller is responsible for applying them to the store.
 *
 * Each numeric range below is the "looks good 90% of the time" band.
 * See the SAFE ARTISTIC PARAMETERS table in defaults.ts for full ranges
 * — the bands here are intentionally narrower than the absolute safe
 * ranges to avoid edge-case visual breakage.
 *
 * Level 3 SAFE PARAMETER: every `rand(a, b)` range below.
 */
export function randomizeSettings(current: UserSettings): RandomizedSettings {
  // `current` is intentionally unused — kept in the signature for future
  // "mutate-from-current" variants (e.g. "randomize just colors"). The
  // current implementation generates a fully fresh random set.

  const settings: UserSettings = {
    // Global visual controls — constrained to "looks good" ranges
    // (roughly the middle 60% of each slider's safe range).
    // WHY not full [0, 3]: 0 = pitch black (boring), 3 = white-clipped
    // (broken). 0.8-1.8 keeps the result vivid but not blown out.
    intensity: rand(0.8, 1.8),
    // motion 0.6-1.6: below 0.6 the visuals feel frozen, above 1.6 they
    // strobe frame-to-frame.
    motion: rand(0.6, 1.6),
    // glow 0.8-2.0: above 2 the haze starts washing out detail.
    glow: rand(0.8, 2.0),
    // particleAmount 0.6-1.5: below 0.6 particle systems look empty,
    // above 1.5 GPU fill cost can drop FPS on weak machines.
    particleAmount: rand(0.6, 1.5),
    // distortion 0.3-1.2: below 0.3 the scene looks flat; above 1.2 the
    // FBM warp breaks into incoherent noise.
    distortion: rand(0.3, 1.2),
    // Audio→visual mapping strengths — moderate to high.
    // WHY above 0.8: the whole point of audio-reactive visuals is to
    // *react*. Below 0.8 the reaction is barely visible. Above 2.0 the
    // visuals overdrive on quiet signals (noise floor becomes visible).
    bassReaction: rand(0.8, 1.8),
    // beatReaction up to 2.0 — beats are short impulses so overdriving
    // them just makes the punch bigger, not visually broken.
    beatReaction: rand(0.8, 2.0),
    // trebleReaction capped at 1.5 — treble is noisy (hi-hats), too much
    // gain makes the visuals flicker with cymbal noise.
    trebleReaction: rand(0.6, 1.5),
    // energyReaction 0.8-1.6 — broadband, mostly used for build-ups.
    energyReaction: rand(0.8, 1.6),
    // Color shift: small, centered. ±0.3 — outside this band the palette
    // is pushed so far it stops resembling the picked colors.
    colorShift: rand(-0.3, 0.3),
    // Colors: vibrant primary + secondary, dark background. Each call
    // to vibrantColor() / darkBackground() is independent — primary and
    // secondary may land on similar hues (rare, but possible). If you
    // need guaranteed-contrast pairs, wrap this with a min-distance check.
    primaryColor: vibrantColor(),
    secondaryColor: vibrantColor(),
    backgroundColor: darkBackground(),
  }

  // Mapping curves: 4 independent random curves, one per audio feature.
  // The store applies them to the VisualEngine via setMappingCurves.
  const mappingCurves: Record<MappingKey, MappingCurve> = {
    bass: randomCurve('bass'),
    beat: randomCurve('beat'),
    treble: randomCurve('treble'),
    energy: randomCurve('energy'),
  }

  return { settings, mappingCurves }
}
