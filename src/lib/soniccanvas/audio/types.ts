import * as THREE from 'three'

/**
 * ============================================================================
 * MODULE: types.ts — the cross-module contract for SonicCanvas
 * ============================================================================
 *
 * WHAT IT IS
 *   Pure type declarations (no runtime code) shared by every layer of
 *   the audio -> visual pipeline. This file is the *contract*: if you
 *   change a field here, every consumer (AudioAnalyzer, VisualMapper,
 *   scenes, exporter, UI store) must be updated to match — the TypeScript
 *   compiler will tell you which ones.
 *
 * WHY IT EXISTS
 *   SonicCanvas has a deliberately layered architecture (spec §4):
 *
 *     AudioEngine ──> AudioAnalyzer ──> VisualMapper ──> VisualEngine/Scenes
 *         ^                                              ^
 *         │                                              │
 *         └──────────  UserSettings (store)  ───────────┘
 *
 *   Each arrow is a typed data flow:
 *     - AudioEngine  -> AudioFeatures  (raw audio -> musical features)
 *     - AudioFeatures + UserSettings -> VisualState  (features + intent -> art)
 *     - VisualState -> shader uniforms  (art -> pixels)
 *
 *   Defining those types in one place means a change to "what the
 *   analyzer produces" forces a review of "what the mapper consumes" —
 *   the compiler catches mismatches at build time, not at runtime.
 *
 * WHAT GOES IN / COMES OUT
 *   - AudioFeatures : produced by AudioAnalyzer, consumed by VisualMapper
 *                     and DebugOverlay.
 *   - VisualState   : produced by VisualMapper, consumed by every Scene.
 *   - UserSettings  : owned by the Zustand store, consumed by VisualMapper
 *                     (and the UI reads/writes them).
 *   - Preset        : owned by the store, applied to UserSettings in bulk.
 *   - SceneId / SceneInfo : the registry of available procedural scenes.
 *
 * CONVENTIONS
 *   - All *musical feature* scalars are normalized to 0..1 (or -1..1 for
 *     signed quantities like colorShift). This keeps the VisualMapper's
 *     `base + audio * reaction` formula dimensionless — sliders in the
 *     UI are 0..1, reactions are 0..1, audio is 0..1, the product is 0..1.
 *   - Waveform/spectrum arrays are *downsampled* by AudioAnalyzer to
 *     fixed sizes (128 each) so shader uniforms can be a known size.
 *   - THREE.Color is used directly in UserSettings (not hex strings) so
 *     the renderer doesn't re-parse colors every frame. The UI keeps a
 *     hex-string mirror for the <input type=color> control and converts
 *     on write.
 *
 * WHAT DEPENDS ON IT
 *   - AudioAnalyzer.ts (produces AudioFeatures)
 *   - VisualMapper.ts (consumes AudioFeatures + UserSettings, produces
 *     VisualState)
 *   - Every scene file under scenes/ (consumes VisualState)
 *   - VisualEngine.ts (consumes VisualState per-scene via Scene interface)
 *   - Zustand store (owns UserSettings + Preset list)
 *
 * WHAT IT DEPENDS ON
 *   - Only `three` (for THREE.Color in UserSettings). No other runtime
 *     imports — this is a contract file, not a logic file.
 * ============================================================================
 */

/**
 * VisualState
 *
 * The output of the VisualMapper. A flat, normalized object that scenes
 * read every frame to drive shader uniforms. All scalar values are in
 * the 0.0–1.0 range unless noted. `pulse` decays toward 0 after a beat.
 *
 * WHY flat (not nested):
 *   Scenes upload these values straight to GLSL uniforms with
 *   `gl.uniform1f(loc, state.brightness)` etc. A flat object = one
 *   lookup per uniform. Nesting (e.g. { color: { hue, sat } }) would
 *   force the scene to chase pointers every frame.
 *
 * WHY normalized 0..1:
 *   Every VisualMapper formula is `base + audio * reaction`. If audio
 *   is 0..1 and the slider values are 0..1, the formula stays in a
 *   predictable range and shader uniforms don't blow up to NaN. Scenes
 *   apply their own artistic multipliers on top of this 0..1 input.
 */
export interface VisualState {
  /** overall brightness / exposure multiplier */
  brightness: number
  /** global scale factor for shapes/displacement */
  scale: number
  /** rotation speed multiplier (signed) */
  rotation: number
  /** distortion / turbulence amount */
  distortion: number
  /** glow / bloom strength */
  glow: number
  /** particle activity / detail level */
  particles: number
  /** short-lived beat impulse 0..1, decays */
  pulse: number
  /** spectral color shift -1..1 */
  colorShift: number
  /** low-frequency energy 0..1 (bass) */
  bass: number
  /** mid-frequency energy 0..1 */
  mid: number
  /** high-frequency energy 0..1 (treble) */
  treble: number
  /** overall energy 0..1 */
  energy: number
}

/**
 * AudioFeatures
 *
 * Normalized musical features produced by AudioAnalyzer each frame.
 * All scalar values normalized to 0..1.
 *
 * WHY normalized: every value here is later multiplied by a 0..1 user
 *   slider (e.g. bassReaction) inside the VisualMapper. Keeping both
 *   sides on the same 0..1 scale means the VisualMapper's `base +
 *   audio * reaction` formula stays dimensionless — the worst case
 *   output is bounded by the slider maximum, never NaN or infinity.
 *
 * WHY Float32Array / Uint8Array (not number[]): the raw sizes are
 *   fixed (128 each) and these arrays are uploaded straight to GLSL
 *   uniform arrays via `gl.uniform1fv(loc, array)`. Typed arrays avoid
 *   a per-frame copy and let the GPU driver read contiguous memory.
 */
export interface AudioFeatures {
  bass: number
  lowMid: number
  mid: number
  highMid: number
  treble: number
  overallEnergy: number
  /** instantaneous beat impulse, decays toward 0 */
  beatPulse: number
  /** raw waveform samples -1..1 (downsampled) */
  waveform: Float32Array
  /** raw spectrum 0..255 (downsampled) */
  spectrum: Uint8Array
  /** current playback time in seconds */
  time: number
  /** total track duration in seconds */
  duration: number
}

/**
 * UserSettings
 *
 * All user-facing artistic controls. These are the "safe-to-modify"
 * parameters (spec §22). Stored centrally and passed to VisualMapper.
 *
 * CUSTOMIZATION: every field below is a slider/setting in the UI and is
 *   safe to experiment with at runtime. The VisualMapper clamps the
 *   *outputs* downstream so extreme values don't crash the renderer —
 *   they just look weird (white-clipped, stuttery, etc.).
 *
 * ============================================================
 * SAFE PARAMETER TABLE (all CUSTOMIZATION-friendly)
 * ------------------------------------------------------------
 * Field            | Range    | Typical | Effect on visuals
 * -----------------|----------|---------|--------------------------
 * intensity        | 0..3     | 1.0     | Global brightness/scale multiplier
 * motion           | 0..3     | 1.0     | Speed of all animation (rotations, flows)
 * glow             | 0..2     | 0.5     | Bloom strength (post-process additive)
 * particleAmount   | 0..1     | 0.5     | Density of particle systems (Orbit scene)
 * distortion       | 0..2     | 0.5     | Base mesh/shader turbulence (FBM strength)
 * bassReaction     | 0..2     | 0.5     | How much bass energy drives visuals
 * beatReaction     | 0..2     | 0.7     | How much beat pulse drives visuals
 * trebleReaction   | 0..2     | 0.3     | How much treble energy drives visuals
 * energyReaction   | 0..2     | 0.4     | How much overall energy drives visuals
 * colorShift       | -1..1    | 0       | Hue offset from spectral content
 * primaryColor     | any      | pink    | Foreground color (THREE.Color)
 * secondaryColor   | any      | blue    | Accent / complementary color
 * backgroundColor  | any      | black   | Clear color + base for crossfades
 * ============================================================
 *
 * Try: bassReaction=2.0 + beatReaction=2.0 for a "club" feel where
 *   every kick punches the visuals; or all reactions at 0.1 for ambient
 *   drifting visuals that ignore the beat entirely.
 * WARNING: Very high values (e.g. intensity=10) will clip shaders to
 *   white and look broken, not "more intense". The renderer does NOT
 *   clamp VisualState for you — keep sliders within the UI's allowed
 *   range to stay safe.
 */
export interface UserSettings {
  // global visual intensity
  // CUSTOMIZATION: master knob — multiplies the whole VisualState output.
  intensity: number
  // motion speed multiplier
  // CUSTOMIZATION: scales all rotation/flow speeds. 0 = freeze.
  motion: number
  // glow strength
  // CUSTOMIZATION: bloom amount. 0 = no glow, 2 = blown-out haze.
  glow: number
  // particle / detail density
  // CUSTOMIZATION: how many particles spawn in Orbit scene, etc.
  particleAmount: number
  // base distortion
  // CUSTOMIZATION: baseline turbulence before audio adds to it.
  distortion: number
  // audio->visual mapping strengths
  // CUSTOMIZATION: the gain applied to each audio feature inside the
  //   VisualMapper's `base + audio * reaction` formula. 0 = that audio
  //   feature has no effect on visuals; 2 = double-strength reaction.
  bassReaction: number
  beatReaction: number
  trebleReaction: number
  energyReaction: number
  // color controls
  // CUSTOMIZATION: signed hue offset. -1 = shift cooler/blue,
  //   +1 = shift warmer/red, driven by spectral content.
  colorShift: number
  // colors as THREE.Color (kept in sync with hex inputs)
  // WHY THREE.Color (not hex string): avoids re-parsing #rrggbb every
  //   frame inside the renderer. The store keeps a hex string mirror for
  //   the <input type=color> control and converts on write.
  primaryColor: THREE.Color
  secondaryColor: THREE.Color
  backgroundColor: THREE.Color
}

/**
 * Preset
 *
 * A coherent style that sets multiple UserSettings at once (spec §18).
 * Stored as Partial<UserSettings> (minus the THREE.Color fields, which
 * are stored as hex strings here for JSON serialization). The store
 * applies a preset by merging its `settings` onto the current
 * UserSettings, converting hex strings to THREE.Color at apply time.
 *
 * WHY partial + strings: presets are persisted as JSON (e.g. localStorage
 *   or a const list in defaults.ts). THREE.Color is not JSON-serializable,
 *   so colors are stored as `#rrggbb` strings and the applier does the
 *   conversion. Partial<> lets a preset only override the fields it cares
 *   about — unspecified fields keep whatever the user previously had.
 */
export interface Preset {
  id: string
  name: string
  description: string
  settings: Partial<Omit<UserSettings, 'primaryColor' | 'secondaryColor' | 'backgroundColor'>> & {
    primaryColor: string
    secondaryColor: string
    backgroundColor: string
  }
}

/**
 * SceneId
 *
 * Identifies a procedural scene. The 5 spec §16 scenes are now all
 * implemented: liquid (Liquid/Plasma), orbit (Orbit), tunnel (Tunnel),
 * grid (Grid/Geometric), and particles (Particle Field).
 *
 * WHY a string union (not enum): tree-shaking removes unused string
 *   literals; enums generate extra runtime code. The SceneManager does
 *   `switch(sceneId)` over these strings.
 */
export type SceneId = 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles'

export interface SceneInfo {
  id: SceneId
  name: string
  description: string
}
