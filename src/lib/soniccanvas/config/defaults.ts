import * as THREE from 'three'
import type { Preset, SceneInfo, UserSettings } from '../audio/types'

/**
 * ============================================================================
 * MODULE: config/defaults.ts — the canonical source of "what the app boots
 *                               with" for the SonicCanvas UI.
 * ============================================================================
 *
 * WHAT IT IS
 *   A pure-data module: it ships three const tables and a few pure helper
 *   functions for converting between the in-memory `UserSettings` shape
 *   (which uses THREE.Color instances) and the JSON-friendly shape used by
 *   presets (which uses `#rrggbb` strings). No side effects, no I/O.
 *
 * WHY IT EXISTS
 *   SonicCanvas deliberately separates *runtime artistic state* (what the
 *   VisualMapper reads each frame) from *shipped content* (what the app
 *   boots with). This file is the *shipped content* half of that split:
 *
 *     shipped content (defaults.ts) ──> store (Zustand) ──> VisualMapper
 *                                          ^
 *                                          |
 *     user content (presetStorage.ts / shareUrl.ts / Randomizer.ts)
 *
 *   - `DEFAULT_SETTINGS` is the bootstrap state applied on first paint.
 *   - `PRESETS` is the immutable list of "factory" looks the user can pick
 *     from the dropdown.
 *   - `SCENES` is the registry of available procedural scenes that the
 *     thumbnail strip iterates over.
 *
 *   Keeping all three in one file means a designer can open *this file*
 *   to tweak shipped palettes / shipped knob positions / shipped scene
 *   list without having to chase them across the codebase.
 *
 * WHAT GOES IN
 *   - Nothing at runtime (pure-data exports).
 *   - Edits at design time: change `#rrggbb` strings, change numeric
 *     defaults, add a new preset entry, add a new scene entry.
 *
 * WHAT COMES OUT
 *   - `DEFAULT_SETTINGS` — initial UserSettings consumed by store.ts.
 *   - `PRESETS` — array of `Preset` consumed by store.ts, presetStorage.ts,
 *     shareUrl.ts (indirectly), and the ControlsPanel UI.
 *   - `SCENES` — array of `SceneInfo` consumed by the scene thumbnail strip
 *     and by shareUrl's `activeScene` round-trip.
 *   - `applyPreset` — pure merge function (UserSettings + Preset →
 *     UserSettings) used by store.setPreset.
 *   - `colorToHex` / `hexToColor` — bidirectional helpers used by UI
 *     color inputs and the share-URL serializer.
 *
 * WHAT DEPENDS ON IT
 *   - ui/store.ts (initial state + setPreset action).
 *   - config/presetStorage.ts (re-exports DEFAULT_SETTINGS, merges user
 *     presets alongside PRESETS).
 *   - config/shareUrl.ts (mirrors the same field set for URL encoding).
 *   - config/Randomizer.ts (reads current settings, returns random ones).
 *   - components/soniccanvas/ControlsPanel.tsx (renders PRESETS, SCENES).
 *
 * WHAT IT DEPENDS ON
 *   - `three` (for THREE.Color in the live UserSettings shape).
 *   - `../audio/types` (UserSettings, Preset, SceneInfo contracts).
 *
 * CUSTOMIZATION:
 *   - Add a new shipped preset by appending an entry to `PRESETS` (a
 *     unique `id` + display `name` + the settings you want to override).
 *   - Add a new shipped scene by appending an entry to `SCENES` (and
 *     adding the matching `SceneId` literal in audio/types.ts, plus the
 *     Scene implementation under visuals/scenes/).
 *   - Tweak the cold-start look by editing `DEFAULT_SETTINGS`.
 *
 * WARNING:
 *   - Preset `settings` fields are intentionally `Partial<>` (see
 *     `Preset` in audio/types.ts). A preset may omit any field — those
 *     keep whatever the user previously had. This is per design (spec §18)
 *     but it means adding a new UserSettings field is non-breaking for
 *     old presets.
 *   - `PRESETS` entries with duplicate `id`s will silently win/lose based
 *     on `Array.find` order — never ship two presets with the same id.
 * ============================================================================
 */

/**
 * ============================================================================
 * SAFE ARTISTIC PARAMETERS — the full UserSettings knob table
 * ============================================================================
 *
 * This is the spec §22 + §51 "safe to modify" surface. Every field below
 * corresponds to a slider or color picker in the ControlsPanel. None of
 * them require touching shader source. The VisualMapper composes them as
 *
 *     finalVisualState = clamp(base + audio_feature * reaction) * intensity
 *
 * so the *reaction* sliders scale how strongly each audio band drives the
 * visuals, while the *base* sliders set the silent-state look. Scenes then
 * multiply by their own per-shader multipliers — that's where extreme
 * values get clipped to avoid NaN/white screens.
 *
 *   FIELD             | TYPE         | SAFE RANGE   | DEFAULT   | WHAT IT DOES
 *   ------------------+--------------+--------------+-----------+----------------------------
 *   intensity         | number       | 0.0 – 3.0    | 1.0       | Global brightness/scale multiplier
 *                    |              |              |           | applied to almost every VisualState
 *                    |              |              |           | field. 0 = black/frozen, 1 = neutral,
 *                    |              |              |           | 3 = very bright/large. Above ~3
 *                    |              |              |           | clips to white in most scenes.
 *   motion            | number       | 0.0 – 3.0    | 1.0       | Speed multiplier for ALL animation
 *                    |              |              |           | (rotations, flows, drift speeds).
 *                    |              |              |           | 0 = freeze-frame; 3 = ~3x speed.
 *   glow              | number       | 0.0 – 3.0    | 1.0       | Bloom / haze strength. 0 = no
 *                    |              |              |           | halo; 2 = strong haze; >3 = white
 *                    |              |              |           | glow clipping.
 *   particleAmount    | number       | 0.0 – 2.0    | 1.0       | Density multiplier for particle
 *                    |              |              |           | systems (Orbit scene 4000 base;
 *                    |              |              |           | Particle Field 8000 base).
 *   distortion        | number       | 0.0 – 2.0    | 0.5       | Baseline turbulence BEFORE audio
 *                    |              |              |           | adds more. Sets the FBM warp amount
 *                    |              |              |           | even when music is silent.
 *   bassReaction      | number       | 0.0 – 3.0    | 1.0       | Gain applied to the bass feature in
 *                    |              |              |           | the VisualMapper formula. 0 = bass
 *                    |              |              |           | has no visual effect; 2 = double.
 *   beatReaction      | number       | 0.0 – 3.0    | 1.0       | Gain applied to the beat pulse
 *                    |              |              |           | (the short-lived impulse that
 *                    |              |              |           | decays after each kick).
 *   trebleReaction    | number       | 0.0 – 3.0    | 1.0       | Gain applied to the treble band
 *                    |              |              |           | (cymbals, hi-hats, high synths).
 *   energyReaction    | number       | 0.0 – 3.0    | 1.0       | Gain applied to the broadband
 *                    |              |              |           | overall-energy feature. Useful
 *                    |              |              |           | for "build-up → drop" looks.
 *   colorShift        | number       | -1.0 – 1.0   | 0.0       | Signed hue offset. -1 = shift
 *                    |              |              |           | cooler/blue; +1 = warmer/red. Can
 *                    |              |              |           | be driven by spectral content too.
 *   primaryColor      | THREE.Color  | any hex      | #ff2d95   | Foreground / "main" color. Used
 *                    |              |              | (pink)    | inside the cosine palette as the
 *                    |              |              |           | dominant hue.
 *   secondaryColor    | THREE.Color  | any hex      | #2d9bff   | Accent / complementary color used
 *                    |              |              | (blue)    | for ring interiors, particle cores,
 *                    |              |              |           | distance-mixed highlights.
 *   backgroundColor   | THREE.Color  | any hex      | #05030d   | Canvas clear color + crossfade base.
 *                    |              |              | (near-    | Should stay DARK — the shaders are
 *                    |              |              |  black)   | designed for additive brightness on
 *                    |              |              |           | a dark base.
 *
 * CUSTOMIZATION: every field is safe to experiment with at runtime. The
 *   VisualMapper clamps the *outputs* downstream — extreme values just
 *   look weird (white-clipped, stuttery, etc.) rather than crash.
 *
 * WARNING: ranges wider than the table above will produce *visually
 *   broken* (not unsafe) results — e.g. intensity=10 saturates shaders to
 *   white, motion=20 makes everything strobe frame-to-frame. Keep within
 *   the listed ranges unless you intentionally want glitch aesthetics.
 *
 * WARNING: colors here are THREE.Color *instances* (mutable, GPU-friendly).
 *   The store keeps them in sync with hex-string mirrors for the
 *   <input type=color> control. Don't push THREE.Color straight through
 *   JSON.stringify (it has no own enumerable fields) — use `colorToHex`
 *   below or the serializer in shareUrl.ts.
 * ============================================================================
 */
export const DEFAULT_SETTINGS: UserSettings = {
  intensity: 1.0,
  motion: 1.0,
  glow: 1.0,
  particleAmount: 1.0,
  distortion: 0.5,
  bassReaction: 1.0,
  beatReaction: 1.0,
  trebleReaction: 1.0,
  energyReaction: 1.0,
  colorShift: 0.0,
  primaryColor: new THREE.Color('#ff2d95'),
  secondaryColor: new THREE.Color('#2d9bff'),
  backgroundColor: new THREE.Color('#05030d'),
}

/**
 * Visual style presets (spec §18).
 *
 * Each preset overrides several settings at once to produce a coherent
 * mood. Colors are intentionally non-indigo/non-blue where possible,
 * except "Cosmic" which uses a blue/purple palette as the spec
 * explicitly describes.
 *
 * WHY each preset is curated rather than generated:
 *   - The VisualMapper math is dimensionless (`base + audio * reaction`)
 *     so arbitrary numbers don't break anything, but *coherent mood*
 *     (palette + motion + reaction balance) needs human taste.
 *   - Each preset was hand-tuned by picking a palette first, then
 *     matching motion/glow to the palette's emotional register.
 *   - The 5 shipped presets cover the 5 main registers in spec §18:
 *       Cosmic  = ambient / chill  (cool palette, slow motion)
 *       Electric= club / dance     (hot palette, fast motion)
 *       Liquid  = organic / liquid (green-blue, fluid distortion)
 *       Sunset  = warm / romantic   (magenta-orange, soft glow)
 *       Minimal = restrained / tech (monochrome, beat-forward)
 *
 * CUSTOMIZATION: extend the array below to ship more presets. Each entry
 *   must have a globally-unique `id` (used as the store's activePresetId
 *   and as the URL-share key). Setting fields are Partial<>, so you may
 *   omit any field — the user's current value for that field is kept.
 *
 * WARNING: changing a preset's `id` after release will orphan any user
 *   localStorage entries that referenced the old id (they'll silently
 *   fall back to DEFAULT_SETTINGS). Treat ids as immutable.
 */
export const PRESETS: Preset[] = [
  // ----------------------------------------------------------------------
  // COSMIC — ambient / chill mood. Cool blue/purple palette paired with
  // slow motion and high glow for a "nebula drifting in deep space" feel.
  // trebleReaction lowered (0.8) so hi-hats don't strobe the calm look.
  {
    id: 'cosmic',
    name: 'Cosmic',
    description: 'Dark space, blue/purple palette, glowing radial shapes, slow motion.',
    settings: {
      intensity: 1.0,
      motion: 0.7,
      glow: 1.5,
      particleAmount: 1.2,
      distortion: 0.4,
      bassReaction: 1.0,
      beatReaction: 1.0,
      trebleReaction: 0.8,
      energyReaction: 1.0,
      colorShift: 0.0,
      primaryColor: '#7c3aed',
      secondaryColor: '#22d3ee',
      backgroundColor: '#050214',
    },
  },
  // ----------------------------------------------------------------------
  // ELECTRIC — club / dance mood. Hot pink + yellow palette, all knobs
  // pushed above 1.0, beatReaction 1.8 (the highest of any preset) so
  // every kick punches the visuals. colorShift +0.2 warms the palette
  // further mid-song.
  {
    id: 'electric',
    name: 'Electric',
    description: 'High contrast, fast pulses, sharp geometry, strong beat reactions.',
    settings: {
      intensity: 1.6,
      motion: 1.6,
      glow: 1.2,
      particleAmount: 1.4,
      distortion: 0.9,
      bassReaction: 1.5,
      beatReaction: 1.8,
      trebleReaction: 1.4,
      energyReaction: 1.3,
      colorShift: 0.2,
      primaryColor: '#ff2d55',
      secondaryColor: '#ffea00',
      backgroundColor: '#0a0a0a',
    },
  },
  // ----------------------------------------------------------------------
  // LIQUID — organic / fluid mood. Teal + sky-blue palette. distortion
  // is at 1.0 (full baseline turbulence) so the Liquid Plasma scene has
  // visible flow even during silent intros. bassReaction bumped to
  // 1.2 so kicks ripple through the "water".
  {
    id: 'liquid',
    name: 'Liquid',
    description: 'Smooth gradients, fluid distortion, organic movement.',
    settings: {
      intensity: 1.0,
      motion: 0.9,
      glow: 1.3,
      particleAmount: 0.8,
      distortion: 1.0,
      bassReaction: 1.2,
      beatReaction: 0.9,
      trebleReaction: 1.0,
      energyReaction: 1.0,
      colorShift: -0.1,
      primaryColor: '#00e5a0',
      secondaryColor: '#00b3ff',
      backgroundColor: '#021014',
    },
  },
  // ----------------------------------------------------------------------
  // SUNSET — warm / romantic mood. Magenta + orange palette with the
  // highest glow of any preset (1.6) for a soft "golden hour" haze.
  // motion 0.8 keeps things calm; energyReaction 1.1 lets swells
  // breathe without overwhelming the beat.
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm magenta/orange palette, soft glow, romantic mood.',
    settings: {
      intensity: 1.0,
      motion: 0.8,
      glow: 1.6,
      particleAmount: 1.0,
      distortion: 0.6,
      bassReaction: 1.1,
      beatReaction: 1.0,
      trebleReaction: 0.9,
      energyReaction: 1.1,
      colorShift: 0.15,
      primaryColor: '#ff6b9d',
      secondaryColor: '#ffb347',
      backgroundColor: '#1a0810',
    },
  },
  // ----------------------------------------------------------------------
  // MINIMAL — restrained / tech mood. Near-monochrome palette (greys),
  // lowest particleAmount (0.5) and lowest distortion (0.3) of any
  // preset, beatReaction pushed to 1.4 so the rhythm remains the
  // focal point. Designed for techno / minimal house.
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Restrained motion, fewer particles, emphasis on rhythm.',
    settings: {
      intensity: 0.8,
      motion: 0.6,
      glow: 0.8,
      particleAmount: 0.5,
      distortion: 0.3,
      bassReaction: 1.2,
      beatReaction: 1.4,
      trebleReaction: 0.6,
      energyReaction: 0.8,
      colorShift: 0.0,
      primaryColor: '#e0e0e0',
      secondaryColor: '#9aa0a6',
      backgroundColor: '#080808',
    },
  },
]

/**
 * Available procedural scenes (spec §16).
 *
 * This is the canonical scene registry — the thumbnail strip in the
 * ControlsPanel and the auto-scene controller both iterate over this
 * array. Order matters: it's the display order in the UI and the
 * rotation order when AutoScene is enabled.
 *
 * All 5 spec §16 scenes are now implemented:
 *   1. Liquid Plasma — fullscreen flowing noise + fluid distortion
 *   2. Orbit — glowing rings + procedural particles in circular motion
 *   3. Tunnel — pseudo-3D forward motion through repeating walls
 *   4. Grid — audio-reactive perspective grid with wave displacement
 *   5. Particle Field — thousands of GPU particles in a curl-noise flow
 *
 * All purely procedural — no imported models or textures (spec §43).
 *
 * CUSTOMIZATION: add a new scene by
 *   1. Adding its literal to the `SceneId` union in audio/types.ts.
 *   2. Implementing the `Scene` interface in visuals/scenes/<Name>Scene.ts.
 *   3. Registering it in SceneManager's factory map.
 *   4. Appending an entry to this array.
 * The id string MUST match the SceneId literal exactly — the manager's
 * switch statement keys off it.
 *
 * WARNING: removing a scene id from this list while a saved user preset
 * references it (via shareUrl's `activeScene`) will fall back to the
 * first scene on next load. Don't ship breaking id renames without a
 * migration shim.
 */
export const SCENES: SceneInfo[] = [
  // 'liquid' — default scene on cold start (matches store.activeScene
  // initial value). Fullscreen clip-space plasma shader; works on any
  // GPU including low-end integrated graphics.
  {
    id: 'liquid',
    name: 'Liquid Plasma',
    description:
      'Fullscreen flowing noise with fluid distortion and glowing color fields.',
  },
  // 'orbit' — the heaviest of the 5 scenes (4000 particles + ring SDF
  // + camera). Best for showcasing beat reaction. Uses PerspectiveCamera.
  {
    id: 'orbit',
    name: 'Orbit',
    description:
      'Glowing geometric rings and particles in circular motion with radial symmetry.',
  },
  // 'tunnel' — pseudo-3D polar tunnel. Clip-space pass-through vertex
  // shader (no real 3D mesh). Good fallback when orbit feels too busy.
  {
    id: 'tunnel',
    name: 'Tunnel',
    description:
      'Infinite-feeling tunnel with forward motion, repeating walls, and pulsing depth.',
  },
  // 'grid' — perspective grid with screen-space-derivative line width
  // (fwidth). The only scene that uses uv.y as a 0..1 depth value.
  {
    id: 'grid',
    name: 'Grid',
    description:
      'Audio-reactive perspective grid with wave displacement and rotating geometry.',
  },
  // 'particles' — heaviest GPU workload (8000 particles, curl-noise
  // flow field computed per-frame in the vertex shader). May drop FPS
  // on integrated GPUs at 1080p export. The user can still select it;
  // AutoSceneController will rotate away after 25s if enabled.
  {
    id: 'particles',
    name: 'Particle Field',
    description:
      'Thousands of procedural particles drifting through a curl-noise flow field with audio-reactive bursts.',
  },
]

/**
 * Apply a preset's stored values onto a live UserSettings object.
 *
 * WHY partial + per-field guards: preset.settings is `Partial<>` so a
 * preset may legally omit any field (the user keeps their existing
 * value for it). The `if (... !== undefined)` check skips omitted
 * fields rather than overwriting them with `undefined`.
 *
 * WHY colors are parsed here (not at preset-definition time): presets
 * are JSON-serializable constants (hex strings). THREE.Color is *not*
 * JSON-serializable (no enumerable own fields). So we convert hex →
 * THREE.Color at apply time, exactly once per preset selection. The
 * resulting UserSettings is the live in-memory shape the renderer reads.
 *
 * Pure function: returns a new UserSettings object; does NOT mutate the
 * input `settings`.
 */
export function applyPreset(settings: UserSettings, preset: Preset): UserSettings {
  // Shallow-clone the current settings so we don't mutate the caller's
  // object (the store's `settings` field is the caller — see store.setPreset).
  const next: UserSettings = { ...settings }
  const s = preset.settings
  // Per-field guarded assignment. WHY not `Object.assign(next, s)`:
  // s's color fields are hex strings, but UserSettings's color fields
  // are THREE.Color instances — Object.assign would write the wrong type.
  if (s.intensity !== undefined) next.intensity = s.intensity
  if (s.motion !== undefined) next.motion = s.motion
  if (s.glow !== undefined) next.glow = s.glow
  if (s.particleAmount !== undefined) next.particleAmount = s.particleAmount
  if (s.distortion !== undefined) next.distortion = s.distortion
  if (s.bassReaction !== undefined) next.bassReaction = s.bassReaction
  if (s.beatReaction !== undefined) next.beatReaction = s.beatReaction
  if (s.trebleReaction !== undefined) next.trebleReaction = s.trebleReaction
  if (s.energyReaction !== undefined) next.energyReaction = s.energyReaction
  if (s.colorShift !== undefined) next.colorShift = s.colorShift
  // Colors: parse hex string → new THREE.Color. New instance each apply
  // so callers can safely mutate the result without aliasing the preset.
  if (s.primaryColor !== undefined) next.primaryColor = new THREE.Color(s.primaryColor)
  if (s.secondaryColor !== undefined) next.secondaryColor = new THREE.Color(s.secondaryColor)
  if (s.backgroundColor !== undefined) next.backgroundColor = new THREE.Color(s.backgroundColor)
  return next
}

/**
 * Convert a THREE.Color to a hex string usable by <input type=color>.
 *
 * WHY getHexString (not .getStyle): getHexString returns lowercase
 * `rrggbb` (6 chars, no #). We prepend #. .getStyle would return
 * `rgb(r, g, b)` which <input type=color> doesn't accept.
 *
 * Used by: every color <input> in the ControlsPanel reads the current
 * THREE.Color from the store, calls this to get the hex for the input's
 * `value` attribute, and writes any user change back via setColorSetting.
 */
export function colorToHex(c: THREE.Color): string {
  return '#' + c.getHexString()
}

/**
 * Parse a hex string into a THREE.Color (returns a new instance).
 *
 * THREE.Color's constructor accepts `#rrggbb`, `#rgb`, `rgb(...)`, and
 * color names ('red', 'cyan', ...). We use the constructor as-is.
 *
 * WHY new instance each call: UserSettings colors are mutable THREE.Color
 * instances. Sharing one across the document would let a slider change
 * leak into another component's view. Always create fresh.
 */
export function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex)
}
