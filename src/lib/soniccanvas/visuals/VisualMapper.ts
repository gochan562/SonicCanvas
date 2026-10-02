import type { AudioFeatures, UserSettings, VisualState } from '../audio/types'
import type { MappingCurve, MappingKey } from './MappingCurves'
import { defaultCurves, evalCurve } from './MappingCurves'

/**
 * ============================================================================
 * MODULE: VisualMapper — audio → visual mapping (THE central choke point)
 * ============================================================================
 *
 * WHAT IT IS
 *   The single, deterministic function that turns "what the music is doing"
 *   into "what the visuals should do". It consumes the normalized
 *   AudioFeatures (bass / beat / treble / energy / mid) the AudioAnalyzer
 *   produces each frame and the user's UserSettings (artistic intent), and
 *   emits a flat, normalized VisualState that every procedural scene reads
 *   to drive its shader uniforms.
 *
 * WHY IT EXISTS
 *   SonicCanvas is layered by design (spec §4, §14, §15, §37):
 *
 *     AudioEngine ──> AudioAnalyzer ──> VisualMapper ──> VisualEngine/Scenes
 *         ^                                              ^
 *         │                                              │
 *         └──────────  UserSettings (store)  ───────────┘
 *
 *   The whole point of funneling every audio→visual mapping through ONE
 *   class is that the mapping table here is the *single source of truth*
 *   for how music maps to art. Want stronger bass? Change one coefficient
 *   here and *every* scene (Liquid, Orbit, Tunnel, Grid, Particles) reacts
 *   more strongly. Without this choke point the same mapping logic would
 *   be duplicated across five scene files and drift out of sync.
 *
 *   The mapping philosophy (spec §15) is also deliberate:
 *
 *       mapped = base + audio * reactionAmount
 *
 *   where `reactionAmount` is user-controlled (bassReaction, etc.).
 *   - At zero audio the visual is `base` — still animated, not frozen.
 *   - The user dials *reactivity* up/down without rewriting the mapping.
 *   - Both sides of the multiplication are 0..1, so the result is bounded
 *     and shader uniforms never blow up to NaN/infinity.
 *
 * WHAT GOES IN
 *   - AudioFeatures (per-frame, from AudioAnalyzer.update)
 *       bass, lowMid, mid, highMid, treble (0..1, smoothed)
 *       overallEnergy (0..1, smoothed)
 *       beatPulse (1.0 on beat, decays toward 0)
 *       waveform / spectrum (not consumed here — scenes use them directly)
 *       time / duration passthrough
 *   - UserSettings (from the Zustand store, set via setSettings)
 *       intensity, motion, glow, particleAmount, distortion (artistic base)
 *       bassReaction, beatReaction, trebleReaction, energyReaction (gains)
 *       colorShift, primaryColor, secondaryColor, backgroundColor (colors)
 *   - MappingCurves (from the mapping editor UI, set via setCurves)
 *       one piecewise-linear curve per feature (bass/beat/treble/energy)
 *   - soloFeature (from the mapping editor's "solo" toggle, set via
 *     setSoloFeature) — when non-null, only that feature contributes.
 *
 * WHAT COMES OUT
 *   VisualState (flat, normalized) consumed by every Scene's update():
 *     brightness, scale, rotation, distortion, glow, particles,
 *     pulse, colorShift, plus passthroughs bass / mid / treble / energy.
 *
 * WHAT DEPENDS ON IT
 *   - VisualEngine.ts (instantiates it, calls map() every frame, hands the
 *     VisualState to SceneManager / scenes)
 *   - Every scene under scenes/ (reads the VisualState to set uniforms)
 *   - The mapping editor UI (calls setCurves / setSoloFeature)
 *
 * WHAT IT DEPENDS ON
 *   - MappingCurves.ts (evalCurve, defaultCurves) for piecewise-linear
 *     remapping of each audio feature before the gain stage.
 *   - audio/types.ts (AudioFeatures, UserSettings, VisualState)
 *
 * COMPLETE PIPELINE (one frame)
 *
 *   AudioFeatures (bass/beat/treble/energy)         ← AudioAnalyzer.update()
 *       │
 *       │ 1. Solo mode: zero out non-soloed features
 *       ▼
 *   effBass / effBeat / effTreble / effEnergy
 *       │
 *       │ 2. Apply mapping curves (piecewise-linear remapping)
 *       ▼
 *   remappedBass / remappedBeat / remappedTreble / remappedEnergy
 *       │
 *       │ 3. Multiply by user's *Reaction settings  (base + audio * reaction)
 *       ▼
 *   bassContribution / beatContribution / trebleContribution / energyContribution
 *       │
 *       │ 4. Combine into VisualState (scale / glow / distortion / etc.)
 *       ▼
 *   VisualState  →  Scenes read it →  shader uniforms  →  pixels
 *
 *   Steps 1-3 are the *input shaping* stage (prepare 0..1 contributions).
 *   Step 4 is the *artistic combination* stage (mix contributions into the
 *   named VisualState fields a shader actually wants).
 *
 * MAPPING TABLE SUMMARY (full Level 2 blocks precede each assignment below)
 *
 *     bass   → scale          (objects swell on kick)
 *     bass   → distortion     (kick wobbles the mesh)
 *     beat   → scale          (extra punch on top of bass)
 *     beat   → pulse          (decaying impulse for shader stabs)
 *     beat   → glow           (beat flash)
 *     mid    → rotation       (signed velocity from mid-band energy)
 *     treble → distortion     (hi-frequency noise wobbles fine detail)
 *     treble → particles      (cymbals = particle activity)
 *     energy → brightness     (overall loudness = exposure)
 *     energy → glow           (overall loudness = bloom)
 *     energy → particles      (energy fuels particle density)
 *     treble−bass (spectral) → colorShift  (warm/cool tilt by spectrum)
 *     user.colorShift + dynamic → colorShift (combined)
 *
 * CUSTOMIZATION
 *   - To make a mapping stronger/ weaker, change the *coefficient* in the
 *     Level 2 block (e.g. `bassContribution * 0.6` → `* 1.2`). Coefficients
 *     are unitless visual multipliers — scenes apply their own scaling on
 *     top, so 0.6 here means "60% of the contribution reaches the field".
 *   - To make a mapping respond to a *different* audio feature, change the
 *     source variable in the assignment. The structure stays valid because
 *     all contributions are 0..1.
 *   - To change the *shape* of the response (e.g. only react to loud bass),
 *     edit the curve in the MappingEditor UI (calls setCurves). The curve
 *     is applied *before* the coefficient, so they compose cleanly.
 *
 * WARNING
 *   This class holds `this.state` as a single mutated object and returns
 *   it from map(). Callers that need a snapshot must copy it — VisualEngine
 *   reads it once per frame so this is fine, but storing the returned
 *   reference for later is a stale-alias footgun.
 * ============================================================================
 */

// ============================================================================
// PARAMETER: ZERO_STATE (initial / fallback VisualState)
// Purpose:   Starting VisualState returned before the first map() call, and
//            the template for `{...ZERO_STATE}` object spreads.
// Safe range: all fields 0 (visually: black, frozen, no distortion, no glow).
// Typical:   left at zero so nothing renders before the first frame.
// Try:       seed `brightness: 0.3` for an immediately-lit first frame.
// WARNING:   do NOT seed non-zero values for distortion/glow/scale —
//            before audio attaches, scenes would render with that constant
//            distortion and it would look like a bug, not a startup state.
// ============================================================================
const ZERO_STATE: VisualState = {
  brightness: 0,
  scale: 0,
  rotation: 0,
  distortion: 0,
  glow: 0,
  particles: 0,
  pulse: 0,
  colorShift: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
}

export class VisualMapper {
  // WHY a single mutable state object: VisualMapper is called every frame
  //   and the consumer (VisualEngine) reads the result immediately. We
  //   mutate this object in place and return it. Allocating a fresh object
  //   per frame would create garbage for the GC; one stable object avoids
  //   that. Callers that need a *snapshot* must clone (none currently do).
  private state: VisualState = { ...ZERO_STATE }

  // WHY default curves live in MappingCurves.defaultCurves() rather than
  //   inline: the mapping editor (MappingEditor.tsx) calls defaultCurves()
  //   too when the user clicks "Reset". One source of truth for the
  //   identity curve shape.
  private curves: Record<MappingKey, MappingCurve> = defaultCurves()

  /** When set, only this feature's contribution is non-zero (solo mode). */
  // WHY solo mode exists: the MappingEditor has a "solo" button per
  //   feature so users can see exactly what bass (or treble, etc.) drives
  //   without the other features muddying the visuals. We zero the others
  //   here rather than in the editor so the effect is identical regardless
  //   of which UI surfaced the request.
  private soloFeature: MappingKey | null = null

  /**
   * Update the mapping curves (called when the user edits them in the UI).
   *
   * Curves are applied in the *next* map() call — no re-render trigger is
   * needed because the VisualEngine reads from this object every frame.
   */
  setCurves(curves: Record<MappingKey, MappingCurve>): void {
    this.curves = curves
  }

  /**
   * Set the solo feature (null = all features active).
   *
   * Solo is sticky — once set, it stays until explicitly cleared. The
   * MappingEditor toggles it off when the user clicks the active feature
   * again or clicks "clear solo".
   */
  setSoloFeature(f: MappingKey | null): void {
    this.soloFeature = f
  }

  /**
   * Compute a new VisualState from audio features and user settings.
   * Called every frame by the VisualEngine.
   *
   * ALGORITHM (Level 2) — the four-stage mapping pipeline:
   *
   *   Stage 1 — Solo gating
   *     If soloFeature is set, all features except the soloed one are
   *     zeroed. This is the cleanest place to gate (before the curve
   *     stage) so we don't shape a feature the user can't see anyway.
   *
   *   Stage 2 — Curve remapping
   *     Each (gated) feature passes through its piecewise-linear curve
   *     (evalCurve). The default identity curve (y=x) means no change;
   *     user-edited curves can compress, expand, threshold, or invert
   *     the response. See MappingCurves.ts for the math.
   *
   *   Stage 3 — Reaction gain
   *     Each remapped value is multiplied by the user's matching
   *     `*Reaction` slider (bassReaction, beatReaction, etc.). This is
   *     the spec §15 `mapped = base + audio * reaction` formula. The
   *     product is the per-feature "contribution" used below.
   *
   *   Stage 4 — Artistic combination
   *     The four contributions (bass / beat / treble / energy) are mixed
   *     into the named VisualState fields a shader wants — scale, glow,
   *     distortion, particles, brightness, rotation, pulse, colorShift.
   *     Each field has its own Level 2 block below explaining the mix.
   *
   * Solo mode: if `soloFeature` is set, all other audio features are
   * zeroed out so the user can see exactly what one feature controls.
   */
  map(features: AudioFeatures, settings: UserSettings): VisualState {
    const s = settings

    // ============================================================
    // STAGE 1: SOLO GATING
    // ------------------------------------------------------------
    // For each feature, pick either the real value or 0 based on whether
    // it matches the soloed feature. If soloFeature is null all features
    // pass through unchanged. The ternary on the `solo` short-circuit
    // avoids an unnecessary branch when solo is off.
    // ============================================================
    const solo = this.soloFeature
    const effBass = solo && solo !== 'bass' ? 0 : features.bass
    const effBeat = solo && solo !== 'beat' ? 0 : features.beatPulse
    const effTreble = solo && solo !== 'treble' ? 0 : features.treble
    const effEnergy = solo && solo !== 'energy' ? 0 : features.overallEnergy

    // ============================================================
    // STAGE 2: CURVE REMAPPING (piecewise-linear response shaping)
    // ------------------------------------------------------------
    // Each feature passes through its MappingCurve. The default identity
    // curve (y=x) makes this a no-op; the user can drag control points in
    // the MappingEditor to:
    //   - boost quiet signals (aggressive preset)
    //   - soften extremes (smooth preset)
    //   - gate until a threshold (threshold preset — only loud beats
    //     trigger visuals)
    //   - invert the response (invert preset — high audio → low visual)
    // See MappingCurves.ts for the math (linear interpolation between
    // control points).
    // ============================================================
    const remappedBass = evalCurve(this.curves.bass, effBass)
    const remappedBeat = evalCurve(this.curves.beat, effBeat)
    const remappedTreble = evalCurve(this.curves.treble, effTreble)
    const remappedEnergy = evalCurve(this.curves.energy, effEnergy)

    // ============================================================
    // STAGE 3: REACTION GAIN  (mapped = base + audio * reaction)
    // ------------------------------------------------------------
    // The spec §15 formula. `remapped*` is the audio side (0..1, possibly
    // reshaped by the user's curve); `s.*Reaction` is the user's gain
    // slider (0..2, 1.0 = neutral). The product is a "contribution" —
    // the strength of that feature's influence on the visuals this frame.
    //
    // These four contributions are the only inputs to the Stage 4 mix
    // below (plus features.mid, which is passed through raw because it
    // has no curve slot — see WARNING below).
    // ============================================================
    const bassContribution = remappedBass * s.bassReaction
    const beatContribution = remappedBeat * s.beatReaction
    const trebleContribution = remappedTreble * s.trebleReaction
    const energyContribution = remappedEnergy * s.energyReaction

    // ============================================================
    // MAPPING: spectral balance → colorShift (dynamic half)
    // Source: (remappedTreble - remappedBass), range -1..1
    // Target: a dynamic hue offset added to the user's static colorShift
    // Formula: dynamicColorShift = (remappedTreble - remappedBass)
    //                              * 0.4 * intensity
    // Result: treble-heavy music shifts warmer; bass-heavy shifts cooler
    // WHY: gives the visuals a "musical" color sense — cymbal washes tilt
    //   the palette one way, kick drops tilt it the other — without
    //   requiring the user to drive it manually.
    // CUSTOMIZATION: the 0.4 coefficient sets how strong the dynamic
    //   shift is. 0.1 = barely perceptible; 1.0 = the palette visibly
    //   swings on every spectral change (can look seasick).
    // WARNING: this is a *difference* of two 0..1 values, so the result
    //   is in [-1, 1]; multiplying by intensity (0..3) keeps the typical
    //   shift in a sensible ±0.4 * 3 = ±1.2 range, then clamped below.
    // ============================================================
    // spectral color shift: treble vs bass balance, normalized -1..1
    const spectralBalance =
      remappedTreble - remappedBass // treble-heavy → positive
    const dynamicColorShift =
      spectralBalance * 0.4 * s.intensity

    // ============================================================
    // PASSTHROUGH FIELDS
    // ------------------------------------------------------------
    // These VisualState fields are raw 0..1 echoes of the (remapped)
    // audio features. Scenes use them for things like "show a bass bar"
    // or "color by mid frequency" where the per-mapping coefficient
    // model doesn't fit.
    //
    // WHY `mid` uses `features.mid` (raw, un-curved, un-reacted):
    //   The curve table only has slots for bass/beat/treble/energy —
    //   adding 'mid' would force every saved preset to migrate. Mid is
    //   used directly for rotation only, so we pass it through raw.
    // ============================================================
    this.state.bass = remappedBass
    this.state.mid = features.mid
    this.state.treble = remappedTreble
    this.state.energy = remappedEnergy

    // ============================================================
    // MAPPING: bass → scale  (and beat → scale, combined)
    // Source: bassContribution + beatContribution (0..2 each)
    // Target: visual scale factor (1.0 = neutral)
    // Formula: scale = 1.0 + bassContribution * 0.6 + beatContribution * 0.5
    // Result: objects swell on every kick and pulse on every beat
    // WHY combine two features into one field: scale is the most natural
    //   "size" knob and both bass (sustained swell) and beat (transient
    //   punch) want to drive it. Splitting them into separate uniforms
    //   would force scenes to add them in shader — wasteful and easy to
    //   get wrong. Combining here means one uniform upload.
    // CUSTOMIZATION: increase the 0.6 / 0.5 coefficients to make kicks
    //   and beats visibly larger. 0.6 → 1.5 makes the scene "breathe"
    //   hard. WARNING: >2.0 can clip past the scene's scale safety
    //   clamp (per-scene), at which point extra bass has no effect.
    // ============================================================
    // scale: base 1, plus bass and beat pulse
    this.state.scale = 1.0 + bassContribution * 0.6 + beatContribution * 0.5

    // ============================================================
    // MAPPING: beat → pulse
    // Source: beatContribution (0..2 typically; decays each frame)
    // Target: short-lived impulse 0..1, decays toward 0
    // Formula: pulse = min(1, beatContribution)
    // Result: a "spike" that scenes use for transient effects
    //   (a flash, a particle burst, a one-shot scale punch)
    // WHY clamp to 1: the AudioAnalyzer's beatPulse already decays
    //   exponentially each frame (decay rate ≈ 1/(60·1.2) ≈ 0.0139 per
    //   frame at 60fps). With reaction up to 2.0 the contribution can
    //   exceed 1.0 briefly on a strong beat — but the field is meant to
    //   be a unit impulse, so we clamp. Scenes that want the *raw*
    //   amplitude should read `features.beatPulse` directly.
    // CUSTOMIZATION: replace min(1, x) with x to allow over-unity pulses
    //   (e.g. for a flash that's brighter than the steady state).
    // WARNING: without the clamp, scenes that multiply by pulse (e.g.
    //   brightness *= 1 + pulse) can overexpose to white on strong beats.
    // ============================================================
    // pulse is the raw beat impulse (clamped 0..1)
    this.state.pulse = Math.min(1, beatContribution)

    // ============================================================
    // MAPPING: mid → rotation
    // Source: features.mid (0..1, smoothed by AudioAnalyzer)
    // Target: signed rotation speed multiplier (radians/sec-ish)
    // Formula: rotation = (0.2 + mid * 1.5 * intensity) * motion
    // Result: scenes rotate faster when mid-band energy is high
    // WHY mid (not bass): bass-driven rotation would feel like the scene
    //   is wobbling on every kick. Mid-band energy tracks *musical
    //   activity* (vocals, snare, guitar) which is a better proxy for
    //   "the music is busy, spin faster". The 0.2 floor keeps a baseline
    //   spin even in silence so visuals never fully freeze.
    // WHY * intensity AND * motion: intensity scales the audio-driven
    //   half; motion scales the whole thing (the user's master motion
    //   slider). Setting motion=0 freezes rotation regardless of audio.
    // CUSTOMIZATION: raise the 1.5 coefficient to make rotation more
    //   reactive to mid; raise the 0.2 floor for a faster idle spin.
    // WARNING: there is no clamp on the result — extreme intensity *
    //   motion (e.g. 3 * 3 = 9x) makes scenes spin so fast they strobe.
    //   The renderer does not clamp this for you.
    // ============================================================
    // rotation speed: signed by mid; multiplied by motion
    this.state.rotation = (0.2 + features.mid * 1.5 * s.intensity) * s.motion

    // ============================================================
    // MAPPING: bass + treble → distortion
    // Source: bassContribution (0..2) + trebleContribution (0..2)
    // Target: distortion / turbulence amount (0..~3 typical)
    // Formula: distortion = s.distortion
    //                       + bassContribution * 0.6
    //                       + trebleContribution * 0.3
    // Result: low-frequency wobble + high-frequency fine-detail noise
    // WHY both bass and treble: bass gives the "wobble" of a kick
    //   moving through the mesh; treble gives the "shimmer" of cymbals
    //   perturbing fine detail. They drive different visual frequencies
    //   of the same field, so combining them feels richer than either
    //   alone. The 0.6 / 0.3 ratio is empirical — bass dominates
    //   because kicks are louder per-bin than hi-hats.
    // CUSTOMIZATION: swap the 0.6 / 0.3 ratio (0.3 / 0.6) for a more
    //   "cymbal-shimmer" feel. Raise both for aggressive turbulence.
    // WARNING: very high distortion (e.g. 5+) can produce visible
    //   geometry tears in scenes that use vertex displacement (Tunnel,
    //   Liquid) — the mesh simply isn't tessellated finely enough.
    // ============================================================
    // distortion: base user setting plus bass influence
    this.state.distortion =
      s.distortion + bassContribution * 0.6 + trebleContribution * 0.3

    // ============================================================
    // MAPPING: energy → brightness
    // Source: energyContribution (0..2 typically)
    // Target: brightness / exposure multiplier (0.6..~2.4 typical)
    // Formula: brightness = 0.6 + energyContribution * 0.9
    // Result: louder music = brighter scene (overall exposure)
    // WHY energy (not bass): brightness is a *broad* effect — pulsing
    //   it on every kick would strobe. Energy is the slowest-smoothed
    //   feature (a=0.8 in AudioAnalyzer) so brightness tracks overall
    //   loudness, breathing in and out with section changes (verse vs
    //   chorus) rather than on every transient. The 0.6 floor keeps the
    //   scene visible at idle.
    // CUSTOMIZATION: raise the 0.9 coefficient for more dynamic range
    //   (silent=dim, loud=blown-out); raise the 0.6 floor for a brighter
    //   baseline. WARNING: very high values clip to white in the shader
    //   — there is no auto-clamp.
    // ============================================================
    // glow/brightness: energy driven + user multiplier
    this.state.brightness =
      0.6 + energyContribution * 0.9

    // ============================================================
    // MAPPING: energy + beat → glow
    // Source: energyContribution (0..2) + beatContribution (0..2)
    // Target: bloom strength (0..~3 typical)
    // Formula: glow = s.glow * (0.5 + energyContribution * 1.2
    //                          + beatContribution * 0.8)
    // Result: sustained glow from energy, transient flash on beats
    // WHY multiply by s.glow: the user's glow slider is the *amount* of
    //   bloom the post-process should add; the audio-driven factor is
    //   the *modulation* of that amount. So glow=0 disables bloom
    //   entirely (multiplicative zero), and glow=1 lets the audio drive
    //   the bloom fully. This keeps glow a clean on/off + intensity knob.
    // WHY the 0.5 floor: even at zero audio, scenes should have *some*
    //   bloom if the user asked for it — otherwise the scene looks
    //   unaccountably flat during silent sections.
    // CUSTOMIZATION: raise the 1.2 to make energy drive bloom harder;
    //   raise the 0.8 to make beat flashes more obvious.
    // WARNING: the (0.5 + 1.2 + 0.8) peak can hit 2.5 inside the parens;
    //   multiplied by s.glow up to 2.0 that's a 5.0 multiplier — many
    //   scenes clamp bloom at ~3.0 to avoid a whiteout.
    // ============================================================
    this.state.glow =
      s.glow * (0.5 + energyContribution * 1.2 + beatContribution * 0.8)

    // ============================================================
    // MAPPING: treble + energy → particles
    // Source: trebleContribution (0..2) + energyContribution (0..2)
    // Target: particle activity / detail level (0..~1.4 typical)
    // Formula: particles = s.particleAmount
    //                       * (0.3 + trebleContribution * 0.7
    //                            + energyContribution * 0.4)
    // Result: cymbals spike particles; overall energy sustains them
    // WHY treble dominates (0.7 vs 0.4): hi-hats and cymbals are the
    //   most "sparkly" sound — they map naturally to a particle burst.
    //   Energy is the *sustained* driver that keeps particles alive
    //   between transient hits.
    // WHY multiply by s.particleAmount: the user's particleAmount
    //   slider is the master density (0 = no particles at all, 1 = full
    //   base density); the audio factor modulates within that envelope.
    //   Setting particleAmount=0 fully disables particles regardless of
    //   audio — useful for scenes (Liquid) where particles look wrong.
    // CUSTOMIZATION: swap the 0.7/0.4 ratio (more energy-driven
    //   particles for sustained fields rather than transient bursts).
    // WARNING: very high particle values can blow past the scene's
    //   allocated buffer (ParticleFieldScene allocates a fixed-size
    //   point cloud), at which point the extra has no visible effect.
    // ============================================================
    // particle activity: treble + energy
    this.state.particles =
      s.particleAmount * (0.3 + trebleContribution * 0.7 + energyContribution * 0.4)

    // ============================================================
    // MAPPING: spectralBalance → colorShift  (combined with user setting)
    // Source: user's static colorShift (-1..1) + dynamicColorShift (-1.2..1.2)
    // Target: final hue offset, clamped to -1..1
    // Formula: colorShift = clamp(user.colorShift + dynamicColorShift, -1, 1)
    // Result: the user's base palette tilt plus the music-driven swing
    // WHY clamp: colorShift is a signed hue offset; outside [-1, 1] the
    //   hue value wraps or saturates in unexpected ways per shader. The
    //   clamp keeps the field in the range every shader assumes.
    // CUSTOMIZATION: to make the user's static setting dominate, lower
    //   the 0.4 multiplier inside dynamicColorShift above; to make the
    //   music dominate, raise it. They compose additively here.
    // WARNING: removing the clamp lets extreme values reach shaders
    //   that may interpret hue>1 as hue-1 (wrap), producing a sudden
    //   palette jump rather than a smooth swing.
    // ============================================================
    // color shift combines user setting and spectral balance
    this.state.colorShift =
      Math.max(-1, Math.min(1, s.colorShift + dynamicColorShift))

    return this.state
  }

  /**
   * Return the most recently computed VisualState. Useful for debug
   * overlays that want to display the values without re-running map().
   *
   * WHY this returns the live reference: VisualEngine reads the state
   *   once per frame immediately after map(); a debug overlay polling
   *   getState() at a different rate just sees the latest value. There
   *   is no allocation. Callers that need a snapshot must clone.
   */
  getState(): VisualState {
    return this.state
  }
}
