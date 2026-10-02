# SonicCanvas — Customization Guide

> **Turn SonicCanvas into your creative coding laboratory.**
>
> This guide explains what every system does, which numbers control the
> visuals, what happens when you change them, and how to experiment
> safely.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Project Architecture](#2-project-architecture)
3. [Audio System](#3-audio-system)
4. [Visual System](#4-visual-system)
5. [Audio → Visual Mapping](#5-audio--visual-mapping)
6. [Shader System](#6-shader-system)
7. [Scene System](#7-scene-system)
8. [Safe Parameters](#8-safe-parameters)
9. [Dangerous Parameters](#9-dangerous-parameters)
10. [Common Experiments (Effect Cookbook)](#10-common-experiments-effect-cookbook)
11. [Troubleshooting](#11-troubleshooting)
12. [How to Create New Effects](#12-how-to-create-new-effects)

---

## 1. Quick Start

If you only want to make the visuals cooler, start here.

### The 30-Second Path

1. Open `src/lib/soniccanvas/config/defaults.ts`
2. Find the `DEFAULT_SETTINGS` object (search for "SAFE ARTISTIC PARAMETERS")
3. Change one value (e.g. `intensity: 2.0` instead of `1.0`)
4. Save the file
5. The browser auto-reloads (Hot Module Replacement)
6. Observe the result

Do not modify infrastructure code until you understand it.

### Quick Parameter Table

| Parameter | What it changes | Safe range | Difficulty |
|---|---|---:|---|
| `intensity` | Overall visual strength | 0–3 | Easy |
| `motion` | Animation speed | 0–3 | Easy |
| `glow` | Brightness / bloom | 0–3 | Easy |
| `particleAmount` | Particle / detail density | 0–2 | Easy |
| `distortion` | Procedural deformation | 0–2 | Easy |
| `bassReaction` | Bass → scale / displacement | 0–3 | Easy |
| `beatReaction` | Beat → impact pulse | 0–3 | Easy |
| `trebleReaction` | Treble → particles / detail | 0–3 | Easy |
| `energyReaction` | Energy → brightness / glow | 0–3 | Easy |
| `colorShift` | Palette phase rotation | -1–1 | Easy |
| `primaryColor` | Main color (hex) | any | Easy |
| `secondaryColor` | Accent color (hex) | any | Easy |
| `backgroundColor` | Background (hex) | any | Easy |

All of these live in `DEFAULT_SETTINGS` inside `defaults.ts`.
You can also change them at runtime via the on-screen sliders.

---

## 2. Project Architecture

### How the systems communicate

```
                 AUDIO FILE (MP3/WAV/OGG)
                     │
                     ▼
               ┌──────────┐
               │AudioEngine│  ← Web Audio API: decode, play, seek, volume
               └─────┬────┘
                     │ AudioBuffer (raw waveform)
                     ▼
               ┌──────────────┐
               │AudioAnalyzer │  ← FFT → frequency bands → smoothing → beat detection
               └─────┬────────┘
                     │ AudioFeatures {bass, mid, treble, energy, beatPulse, ...}
                     ▼
               ┌──────────────┐
               │ MappingCurves│  ← piecewise-linear remapping (user-editable curves)
               └─────┬────────┘
                     │ remapped features
                     ▼
               ┌──────────────┐
               │ VisualMapper  │  ← combines remapped audio × user settings → VisualState
               └─────┬────────┘
                     │ VisualState {scale, glow, distortion, pulse, ...}
                     ▼
               ┌──────────────┐
               │ SceneManager  │  ← picks active scene, handles crossfade transitions
               └─────┬────────┘
                     │ active scene(s)
                     ▼
               ┌──────────────┐
               │ VisualEngine  │  ← Three.js WebGLRenderer, render loop, FPS scaler
               └─────┬────────┘
                     │ shader uniforms
                     ▼
                    WebGL
                     │
                     ▼
                  CANVAS ← what the user sees
```

### Key principle: separated pipeline

The spec's most important design principle (§4) is: **separate audio
analysis from visual mapping from rendering.** This means:

- You can change a shader without touching the audio code.
- You can change how bass maps to visuals without touching the FFT.
- You can add a new scene without rewriting the analyzer.

### File map

```
src/lib/soniccanvas/
├── audio/
│   ├── AudioEngine.ts      ← Web Audio graph, play/pause/seek, master clock
│   ├── AudioAnalyzer.ts    ← FFT, frequency bands, smoothing, beat detection
│   └── types.ts            ← TypeScript interfaces (AudioFeatures, UserSettings, etc.)
├── visuals/
│   ├── VisualEngine.ts     ← Three.js renderer, RAF loop, FPS auto-scaler
│   ├── VisualMapper.ts     ← audio→visual mapping formulas (THE creative heart)
│   ├── SceneManager.ts     ← scene switching + crossfade transitions
│   ├── MappingCurves.ts    ← piecewise-linear response curves + curve presets
│   ├── AutoSceneController.ts ← energy-based automatic scene rotation
│   └── scenes/
│       ├── Scene.ts         ← interface that all scenes implement
│       ├── LiquidScene.ts   ← fullscreen plasma (FBM + domain warping)
│       ├── OrbitScene.ts    ← glowing rings + 4000 orbiting particles
│       ├── TunnelScene.ts   ← pseudo-3D polar tunnel
│       ├── GridScene.ts     ← audio-reactive perspective grid
│       └── ParticleFieldScene.ts ← 8000 GPU particles in curl-noise flow
├── config/
│   ├── defaults.ts         ← presets, scene list, default settings
│   ├── Randomizer.ts       ← random-but-coherent settings generator
│   ├── presetStorage.ts    ← save/load presets to localStorage
│   └── shareUrl.ts         ← encode/decode settings as URL hash
├── export/
│   └── VideoExporter.ts    ← MediaRecorder + canvas.captureStream → WebM
└── ui/
    ├── store.ts            ← Zustand global state
    └── EngineContext.ts    ← React context for engine access

src/components/soniccanvas/
├── SonicCanvas.tsx         ← app shell (layout, wires engines to store)
├── SonicCanvasClient.tsx   ← client-only wrapper (prevents SSR hydration errors)
├── UploadScreen.tsx        ← drag-drop + file chooser + demo tone generator
├── ControlsPanel.tsx       ← sliders, preset selector, scene thumbnails
├── PlayerBar.tsx           ← play/pause, track waveform, volume
├── MappingEditor.tsx       ← visual curve editor + solo mode
├── TrackWaveform.tsx       ← full-song waveform with click-to-seek
├── WaveformDisplay.tsx     ← live waveform + spectrum mini-display
├── ExportDialog.tsx        ← export modal (resolution/quality/download)
├── SavePresetDialog.tsx    ← save settings to localStorage
├── SharePresetDialog.tsx   ← share settings via URL
├── DebugOverlay.tsx        ← FPS, scene, audio bars
├── NowPlayingOverlay.tsx   ← track name, scene, solo badge, auto-scene timer
├── KeyboardShortcutsHelp.tsx ← help dialog for all shortcuts
├── FullscreenToggle.tsx    ← fullscreen API button
└── SonnerToaster.tsx       ← toast notification wrapper (unused — radix toast used)
```

---

## 3. Audio System

### The audio pipeline

```
MP3/WAV/OGG file
    ↓
File.arrayBuffer()          ← read the file into raw bytes
    ↓
AudioContext.decodeAudioData()  ← browser decodes to PCM samples
    ↓
AudioBuffer                 ← decoded waveform (channels × samples)
    ↓
AudioBufferSourceNode       ← plays the buffer (one-shot, can't restart)
    ↓
AnalyserNode                ← FFT analysis without affecting audio
    ↓
AudioFeatures               ← normalized 0..1 values for each band
```

### What each stage means

**AudioBuffer** — Contains the decoded waveform. Think of it as a big
array of floating-point samples (-1.0 to 1.0). A 3-minute song at 44.1kHz
has ~8 million samples.

**AnalyserNode** — A Web Audio node that lets you inspect the audio
without changing it. It provides:
- `getByteFrequencyData()` — energy at each frequency (FFT output)
- `getFloatTimeDomainData()` — the raw waveform (amplitude over time)

**FFT (Fast Fourier Transform)** — Transforms the audio from
"amplitude over time" into "energy at different frequencies." This is
what makes it possible to know "how much bass is happening right now"
without needing to analyze the waveform manually.

### Frequency bands

The spectrum is split into 5 bands based on Hz ranges:

| Band | Hz range | What it represents |
|---|---|---|
| Bass | 20–150 Hz | Kick drum, bass guitar |
| Low Mid | 150–400 Hz | Lower vocals, rhythm guitar |
| Mid | 400–2000 Hz | Vocals, melody instruments |
| High Mid | 2000–6000 Hz | Cymbals, harmonics |
| Treble | 6000–16000+ Hz | Air, sparkle, sibilance |

The code computes which FFT bins correspond to which Hz range based
on the audio sample rate. This is in `AudioAnalyzer.ts` — search for
`BAND_RANGES` and `computeBandBins()`.

### Why multiple bins are averaged

A single FFT bin is noisy — it represents a narrow frequency slice and
fluctuates rapidly. By averaging all bins in a band (e.g. all bins from
20–150 Hz for bass), we get a more stable representation of "how much
bass energy is present right now."

### Why values are normalized

Raw FFT values are 0–255 (8-bit). We divide by 255 and apply a
perceptual gamma (`Math.pow(avg, 0.6)`) so that:
- Quiet music still produces visible visual response
- The 0–1 range is easy to map into shader uniforms

### Smoothing

Without smoothing, values jump wildly:
```
Raw:     0.10 → 0.90 → 0.20 → 1.00  (jittery, unpleasant)
Smoothed: 0.10 → 0.30 → 0.27 → 0.45  (fluid, musical)
```

The smoothing formula is a one-pole exponential low-pass:
```
smoothed = old × factor + new × (1 - factor)
```

- `factor = 0.75` (bass): relatively smooth, follows the music
- `factor = 0.55` (treble): faster response, more sparkle
- `factor = 0.80` (energy): very smooth, overall feel

**CUSTOMIZATION:** Lower the factor → faster response → more jitter.
Raise it → smoother → more laggy. Find the values in `AudioAnalyzer.ts`
— search for `this.smooth`.

### Beat detection

The beat detector (spec §13) is a simple energy-based onset detector:

1. Track the rolling average of bass energy (last ~3 seconds)
2. When current bass exceeds `avg × 1.4 + sqrt(variance) × 1.5 + 0.05`
3. AND at least 0.12s has passed since the last beat (refractory period)
4. → A beat is detected → `beatPulse = 1.0`
5. `beatPulse` decays toward 0 over ~1.2 seconds

Visual representation:
```
quiet → quiet → LOUD SPIKE → beat detected → pulse = 1.0

pulse decays: 1.0 → 0.8 → 0.6 → 0.4 → 0.2 → 0.0
```

**CUSTOMIZATION:**
- Increase the `1.4` multiplier → requires stronger spikes → fewer beats
- Decrease it → more sensitive → more beats (but more false positives)
- Change `0.12` (minGap) → controls minimum time between beats

---

## 4. Visual System

### The render loop

Every frame, the VisualEngine:

1. Reads audio time from `AudioEngine.getCurrentTime()` (master clock)
2. Reads FFT data from `AudioAnalyzer.update()`
3. Passes `AudioFeatures` through `MappingCurves` (user-editable)
4. Passes remapped features through `VisualMapper.map()` → `VisualState`
5. Clears the canvas to the user's background color
6. Updates shader uniforms on the active scene(s)
7. Renders the scene(s) via Three.js → WebGL

### Master clock

Visual time is derived from audio playback position, NOT from
`requestAnimationFrame` elapsed time. This means:
- Seeking the audio → visuals jump to the right position
- Pausing → visuals freeze
- Recording export → perfectly in sync

### FPS auto-scaler

If FPS drops below 45 for 3 seconds, the internal render quality steps
down (1.0 → 0.75 → 0.5). If FPS stays above 57 for 6 seconds, it steps
back up. This keeps performance smooth on slower GPUs.

**CUSTOMIZATION:** The thresholds are in `VisualEngine.ts` — search for
`fpsFloor` and `fpsCeil`.

### Scene transitions

When switching scenes, the SceneManager:
1. Keeps both old and new scenes alive
2. Eases old scene's opacity from 1→0 and new scene's from 0→1
3. Uses ease-in-out cubic for smooth blending
4. Disposes the old scene when transition completes (frees GPU memory)

Three transition styles: `crossfade` (smooth blend), `wipe` (hard step),
`zoom` (punchy overshoot). Selectable in the Advanced accordion.

---

## 5. Audio → Visual Mapping

This is the creative heart of SonicCanvas. The `VisualMapper` converts
audio features into visual parameters.

### The mapping pipeline

```
AudioFeatures (bass, beat, treble, energy)
    ↓
Apply MappingCurves (piecewise-linear remapping, user-editable)
    ↓
Multiply by user's *Reaction settings
    ↓
Combine into VisualState
```

### Every mapping explained

#### Bass → Scale

```
Source:   bass energy (0..1)
Target:   visual scale factor
Formula:  scale = 1.0 + bass × bassReaction × 0.6
Result:   objects expand when bass hits
```

- `bassReaction = 0` → bass has no effect
- `bassReaction = 1` → normal expansion
- `bassReaction = 2` → twice as strong
- `bassReaction = 3` → very aggressive pulsing

#### Beat → Pulse

```
Source:   beatPulse (0..1, decaying spike)
Target:   impact pulse + glow flash
Formula:  pulse = min(1, beat × beatReaction)
Result:   sharp visual "hit" on each detected beat
```

- `beatReaction = 0` → no beat impact
- `beatReaction = 1` → normal beat flash
- `beatReaction = 2` → strong beat punch
- `beatReaction = 3` → every beat is an explosion

#### Treble → Particles

```
Source:   treble energy (0..1)
Target:   particle activity / detail level
Formula:  particles = particleAmount × (0.3 + treble × trebleReaction × 0.7)
Result:   high frequencies create sparkle and detail
```

#### Energy → Brightness

```
Source:   overall energy (0..1)
Target:   brightness multiplier
Formula:  brightness = 0.6 + energy × energyReaction × 0.9
Result:   louder sections are brighter
```

#### Mid → Rotation

```
Source:   mid energy (0..1)
Target:   rotation speed
Formula:  rotation = (0.2 + mid × 1.5 × intensity) × motion
Result:   mid frequencies drive rotational motion
```

#### Spectral balance → Color shift

```
Source:   treble - bass (positive = treble-heavy, negative = bass-heavy)
Target:   color palette phase
Formula:  colorShift = userColorShift + (treble - bass) × 0.4 × intensity
Result:   the color palette shifts as the spectral balance changes
```

### Mapping curves

Before multiplying by `*Reaction`, each audio feature passes through
a piecewise-linear curve. This lets you shape the response — for
example, make bass aggressive at low volumes but clamp at high volumes.

5 preset curve shapes are available:
- **Linear** — identity (1:1 passthrough)
- **Aggressive** — boosts low values, saturates high
- **Smooth** — gentle S-curve, softens extremes
- **Threshold** — nothing until 0.4, then ramps (good for beat gates)
- **Inverted** — reversed response

Edit curves visually in the MappingEditor (in the controls panel).
Use `Shift+1-4` to solo individual features and see their effect.

### Solo mode

Press `Shift+1` (bass), `Shift+2` (beat), `Shift+3` (treble), or
`Shift+4` (energy) to isolate a single feature. All other features are
zeroed out so you can see exactly what that one feature controls.

---

## 6. Shader System

### How shaders work in SonicCanvas

Each scene uses a `ShaderMaterial` with:
- A **vertex shader** (`.vert`) — computes screen positions
- A **fragment shader** (`.frag`) — computes pixel colors

Most scenes use a "fullscreen quad" approach: a single rectangle that
covers the screen, and the fragment shader generates the entire visual
content mathematically (no 3D models, no textures).

### GLSL concepts used in SonicCanvas

**UV coordinates** — `vUv` is a `vec2` where (0,0) is bottom-left and
(1,1) is top-right of the screen. We center it: `uv = vUv - 0.5` so
(0,0) is the center of the screen.

**Normalized coordinates** — After centering, we adjust for aspect ratio:
`uv.x *= resolution.x / resolution.y` so circles don't squash on wide
screens.

**sin() / cos()** — Used for smooth oscillation. Instead of `0 → 1 → 0`,
sin creates a continuous wave:
```
    /\
   /  \
__/    \__
```
Used for: pulsing, floating, rotation, wave motion, breathing effects.

**FBM (Fractional Brownian Motion)** — Sums several octaves of value
noise with frequency doubling and amplitude halving. Creates organic,
cloud-like patterns. Used heavily in LiquidScene.

**Domain warping** — Using noise to displace the coordinates of *other*
noise. Creates swirling, fluid-like distortion. The LiquidScene uses
two layers of warping (IQ's classic pattern).

**Cosine palette** — `color = a + b × cos(2π(c×t + d))` generates
smooth, coherent color gradients. Changing `d` rotates the palette
(which is what `colorShift` does).

**Curl noise** — A divergence-free flow field derived from gradient
noise. Produces swirly, fluid-like motion without sources or sinks.
Used in ParticleFieldScene for particle drift.

**Signed distance functions (SDF)** — Instead of storing a 3D model,
an SDF mathematically describes the distance from any point to the
shape's surface. Negative = inside, positive = outside, zero = on the
surface. Used for ring shapes in OrbitScene.

**Additive blending** — `glBlendFunc(SRC_ALPHA, ONE)`. Overlapping
particles add their colors together → areas with many particles glow
brighter. Creates a neon-dust look.

**smoothstep()** — GLSL's built-in function for smooth transitions.
`smoothstep(edge0, edge1, x)` returns 0 when x < edge0, 1 when
x > edge1, and a smooth curve in between. Used for anti-aliased edges,
glow falloff, and ring thickness.

### Key shader uniforms

Every scene receives these uniforms (updated every frame):

| Uniform | Range | What it controls |
|---|---|---|
| `u_time` | seconds | Animation clock (from audio position) |
| `u_bass` | 0–1 | Bass energy → drives scale/distortion |
| `u_mid` | 0–1 | Mid energy → drives rotation |
| `u_treble` | 0–1 | Treble energy → drives detail/particles |
| `u_energy` | 0–1 | Overall energy → drives brightness |
| `u_beat` | 0–1 | Beat pulse (decaying) → drives impact/shockwave |
| `u_intensity` | 0–3 | Overall effect strength |
| `u_motion` | 0–3 | Animation speed |
| `u_glow` | 0–3 | Glow/bloom strength |
| `u_distortion` | 0–2 | Procedural deformation amount |
| `u_colorShift` | -1–1 | Palette phase rotation |
| `u_primary` | vec3 | Primary color |
| `u_secondary` | vec3 | Secondary color |
| `u_background` | vec3 | Background color |
| `u_opacity` | 0–1 | Crossfade opacity (1 = fully visible) |

**CUSTOMIZATION:** All of these are safe to experiment with. The values
are set by `VisualMapper.map()` and pushed to the scene's
`material.uniforms` every frame.

---

## 7. Scene System

### How scenes work

```
SceneManager
    ↓
current scene (one of: Liquid, Orbit, Tunnel, Grid, Particle Field)
    ↓
scene.init()     ← creates Three.js objects + shader material
    ↓
scene.update()    ← called every frame, pushes VisualState into uniforms
    ↓
scene.render()    ← draws to the WebGL canvas
    ↓
scene.dispose()   ← frees GPU memory when scene is switched away
```

### Available scenes

| Scene | File | Visual concept | GPU cost |
|---|---|---|---|
| Liquid Plasma | `LiquidScene.ts` | Flowing noise + domain warping | Low (fullscreen shader) |
| Orbit | `OrbitScene.ts` | Rings + 4000 orbiting particles | Medium |
| Tunnel | `TunnelScene.ts` | Pseudo-3D polar tunnel | Low |
| Grid | `GridScene.ts` | Perspective grid with waves | Low |
| Particle Field | `ParticleFieldScene.ts` | 8000 GPU particles in curl-noise | Medium-High |

### How to switch scenes

- **UI:** Click a scene thumbnail in the Visual Style card
- **Keyboard:** Press `1`–`5` (Liquid/Orbit/Tunnel/Grid/Particles)
- **Auto-scene mode:** Toggle with `A` — rotates scenes based on energy

### How to create a new scene

1. **Create a new scene module** in
   `src/lib/soniccanvas/visuals/scenes/MyScene.ts`
2. **Implement the `Scene` interface** — define `init()`, `update()`,
   `setOpacity()`, `resize()`, `render()`, `dispose()`
3. **Write your GLSL shaders** — use the existing scenes as templates
4. **Connect VisualState values** to your shader uniforms in `update()`
5. **Register the scene** in `SceneManager.ensureScene()` — add a
   `case 'myscene': s = new MyScene(); break`
6. **Add to the scene list** in `config/defaults.ts` — add to the
   `SCENES` array and extend `SceneId` in `audio/types.ts`
7. **Add to AutoSceneController** — add your scene id to `SCENE_ORDER`
8. **Add a thumbnail icon** — add a case in `SceneThumbIcon` in
   `ControlsPanel.tsx`

### Recipe: minimal new scene

```typescript
import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float u_time;
  uniform vec3 u_primary;
  uniform float u_opacity;
  void main() {
    vec2 uv = vUv - 0.5;
    float d = length(uv);
    vec3 col = u_primary * smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(col, u_opacity);
  }
`

export class MyScene implements Scene {
  readonly id = 'myscene'
  readonly name = 'My Scene'
  readonly description = 'A simple radial glow.'
  // ... implement init/update/setOpacity/resize/render/dispose
  // (copy the structure from LiquidScene.ts)
}
```

---

## 8. Safe Parameters

### 🟢 SAFE — Change freely, should not break anything

| Parameter | File | Range | What it does |
|---|---|---|---|
| `intensity` | defaults.ts | 0–3 | Overall visual strength |
| `motion` | defaults.ts | 0–3 | Animation speed |
| `glow` | defaults.ts | 0–3 | Bloom/brightness |
| `particleAmount` | defaults.ts | 0–2 | Particle density |
| `distortion` | defaults.ts | 0–2 | Deformation amount |
| `bassReaction` | defaults.ts | 0–3 | Bass → visuals strength |
| `beatReaction` | defaults.ts | 0–3 | Beat → impact strength |
| `trebleReaction` | defaults.ts | 0–3 | Treble → detail strength |
| `energyReaction` | defaults.ts | 0–3 | Energy → brightness |
| `colorShift` | defaults.ts | -1–1 | Palette rotation |
| `primaryColor` | defaults.ts | any hex | Main color |
| `secondaryColor` | defaults.ts | any hex | Accent color |
| `backgroundColor` | defaults.ts | any hex | Background |
| `transitionSpeed` | SceneManager.ts | 0.5–5.0 | Crossfade duration |
| `maxSceneTime` | AutoSceneController.ts | 10–60 | Auto-rotation interval |
| `minGap` | AutoSceneController.ts | 3–15 | Min time between auto-switches |
| `QUALITY_BITRATES` | VideoExporter.ts | 1–15 Mbps | Export video quality |
| `PARTICLE_COUNT` | OrbitScene.ts | 500–10000 | Orbit particle count |
| `PARTICLE_COUNT` | ParticleFieldScene.ts | 1000–20000 | Flow particle count |

### 🟡 CAUTION — May produce strange visuals or performance issues

| Parameter | File | What can go wrong |
|---|---|---|
| `analyser.fftSize` | AudioAnalyzer.ts | Changes frequency resolution; band boundaries need recalculation |
| `smoothingTimeConstant` | AudioAnalyzer.ts | Too high = laggy, too low = jittery |
| Per-band smoothing factors | AudioAnalyzer.ts | `this.smooth(oldV, newV, factor)` — 0 = no smoothing, 1 = frozen |
| `fpsFloor` / `fpsCeil` | VisualEngine.ts | Too close = frequent quality oscillation |
| `qualitySteps` | VisualEngine.ts | Values must be ascending [min, mid, max] |
| `dropThreshold` | AutoSceneController.ts | Too low = false beat triggers; too high = never triggers |
| `historyLen` | AutoSceneController.ts | Too short = unstable average; too long = stale average |
| Curve control point count | MappingCurves.ts | >8 points can make the editor UI crowded |

### 🔴 DANGER — Understand the system before changing

| Area | File | What can break |
|---|---|---|
| WebGL context creation | VisualEngine.ts | All shaders depend on this context |
| `preserveDrawingBuffer: true` | VisualEngine.ts | Required for canvas.captureStream(); removing breaks export |
| Audio graph connections | AudioEngine.ts | Wrong routing = no sound or no analysis |
| `MediaRecorder` setup | VideoExporter.ts | Wrong MIME type = silent video or crash |
| `decodeAudioData` call | AudioEngine.ts | Must pass a copy (`slice(0)`) or the buffer is consumed |
| Template literal backticks | All scene files | Backticks inside GLSL comments break the string |
| `ssr: false` in SonicCanvasClient | SonicCanvasClient.tsx | Removing causes Radix UI hydration errors |
| AudioContext autoplay policy | AudioEngine.ts | `resume()` must not be awaited in non-gesture contexts |

---

## 9. Dangerous Parameters

These are NOT "don't touch" — they're "understand before you change."

### WebGL initialization (`VisualEngine.ts`)

```typescript
const ctx = canvas.getContext('webgl2', {
  alpha: false,              // WHY: opaque canvas is faster
  antialias: false,          // WHY: shaders handle their own AA
  preserveDrawingBuffer: true, // WARNING: needed for captureStream
  powerPreference: 'high-performance',
})
```

If you remove `preserveDrawingBuffer: true`, the canvas capture for
video export will produce black frames. The performance cost is small
on modern GPUs.

### Audio graph routing (`AudioEngine.ts`)

```
AudioBufferSourceNode → AnalyserNode → GainNode → destination
                                             ↘ MediaStreamDestination (export only)
```

If you change this routing, you may lose either the audio analysis
(breaking all visuals) or the audio output (silence) or the export
audio track.

### FFT size (`AudioAnalyzer.ts`)

```typescript
this.analyser.fftSize = 2048
```

Changing this changes the number of frequency bins available. The band
boundary calculations (`computeBandBins()`) automatically adapt to the
new size, but:
- Too small (256) → poor frequency resolution, bands overlap
- Too large (16384) → better resolution but higher CPU cost
- Must be a power of 2

---

## 10. Common Experiments (Effect Cookbook)

### Make the bass reaction stronger

Find: `bassReaction` in `defaults.ts` or use the on-screen slider.

```
bassReaction = 2.0
```

**Result:** Objects expand more aggressively on bass hits.

---

### Make the animation calmer

```
motion = 0.5
```

**Result:** Slower visual movement. Good for ambient/relaxing tracks.

---

### Make beats hit harder

```
beatReaction = 2.5
```

**Result:** Each detected beat produces a stronger visual impact —
shockwaves, flash, scale pulse.

---

### Make the visuals glow more

```
glow = 2.0
```

**Result:** Brighter bloom around objects. Be careful — extreme values
can cause overexposure (everything turns white).

---

### Make particles react more to high frequencies

```
trebleReaction = 2.0
```

**Result:** Cymbals and high-frequency content create more particle
activity and detail.

---

### Make the visuals more chaotic

```
distortion = 1.5
motion = 2.0
bassReaction = 2.5
```

**Result:** More deformation, faster movement, stronger bass response.

---

### Make the visuals more minimal

```
particleAmount = 0.3
distortion = 0.2
motion = 0.5
bassReaction = 0.5
beatReaction = 0.5
```

**Result:** Subtle, restrained visuals. Emphasis on rhythm over energy.

---

### Change the color palette

In `defaults.ts`, change the preset colors:

```typescript
primaryColor: '#00ff88',      // green
secondaryColor: '#ff00aa',    // magenta
backgroundColor: '#0a0015',    // very dark purple
```

Or use the on-screen color pickers. Try complementary colors
(opposite on the color wheel) for high contrast.

---

### Create a "bass universe" preset

```
bassReaction = 3.0
trebleReaction = 0.0
beatReaction = 1.5
energyReaction = 0.5
```

**Result:** Only bass drives the visuals. Treble has no effect. Good
for understanding what bass controls.

---

### No music reaction (base animation only)

Set ALL reaction strengths to 0:

```
bassReaction = 0.0
beatReaction = 0.0
trebleReaction = 0.0
energyReaction = 0.0
```

**Result:** The scene animates on its own without audio input. This
shows you what the "base animation" looks like vs. the audio-driven
component.

---

### Extreme beat

```
beatReaction = 3.0
```

**Result:** Every detected beat creates a massive visual explosion.

---

### Slow motion

```
motion = 0.2
```

**Result:** Very slow, dreamy visual movement. Good for ambient music.

---

## 11. Troubleshooting

### Everything is black

**Possible causes:**
1. Shader compilation error — check the browser console for GLSL errors
2. `u_opacity` is 0 — check if a transition is stuck
3. `backgroundColor` is the same as `primaryColor`
4. WebGL context lost — refresh the page
5. `settingsRef` is null in VisualEngine — the engine wasn't initialized

**How to debug:** Enable the debug overlay (press `D`) and check if
FPS > 0 and scene is not null.

---

### Visuals do not react to music

**Check in order:**
1. Audio is actually playing (press Space, check the time display)
2. `AudioContext.state` is "running" (check via debug overlay or console:
   `window.__sonicAudio.getAnalyser().context.state`)
3. AnalyserNode receives data: `window.__sonicAudio.getAnalyser()
   .getByteFrequencyData(new Uint8Array(1024))` — should show non-zero
   values
4. `getLatestFeatures()` returns non-null: `window.__sonicVisual
   .getLatestFeatures()?.bass` — should be > 0
5. Solo mode isn't isolating a different feature (check for "Solo: X"
   badge on canvas; press `Shift+1-4` to toggle)
6. All `*Reaction` sliders are above 0

---

### Visuals are extremely jittery

**Likely causes:**
1. Smoothing factors too low — increase in `AudioAnalyzer.ts`
2. Beat threshold too sensitive — increase `dropThreshold` or `minGap`
3. `motion` set too high

**Fix:** Try `motion = 0.5` and check if the jitter improves.

---

### FPS is low

**Check:**
1. Particle count — `PARTICLE_COUNT` in scene files. 8000+ particles
   can be heavy on integrated GPUs
2. Shader complexity — FBM with 5+ octaves is expensive; reduce to 3
3. Internal resolution — the FPS auto-scaler should handle this, but
   if it's stuck, check `getQuality()` in the debug overlay
4. Browser extensions — disable them and retest

---

### Export has no audio

**Check:**
1. `MediaStreamDestination` is created — `audio.getMediaStreamDestination()`
   should return non-null
2. Audio source is connected to both `AnalyserNode` AND
   `MediaStreamDestination`
3. `MediaRecorder` is using a MIME type with `opus` audio codec
4. Audio is playing during the export (the exporter starts playback)

---

### Hydration mismatch error

**Cause:** Radix UI components generate different IDs during SSR vs
client hydration.

**Fix:** Ensure `SonicCanvasClient.tsx` uses `dynamic(..., { ssr: false })`
and that `page.tsx` imports `SonicCanvasClient` (not `SonicCanvas`
directly).

---

### Track waveform is flat

**Cause:** The peak envelope computation may have failed, or the audio
buffer is empty.

**Fix:** Check `window.__sonicAudio.getBuffer()` returns non-null. The
waveform is computed in `TrackWaveform.tsx` — search for
`computePeaks()`.

---

## 12. How to Create New Effects

### Adding a new scene

See [Section 7: Scene System](#7-scene-system) for the full recipe.

### Adding a new preset

1. Open `src/lib/soniccanvas/config/defaults.ts`
2. Find the `PRESETS` array
3. Add a new entry:
```typescript
{
  id: 'my-preset',
  name: 'My Preset',
  description: 'A cool new mood.',
  settings: {
    intensity: 1.5,
    motion: 0.8,
    glow: 1.8,
    // ... fill in all fields
    primaryColor: '#ff6600',
    secondaryColor: '#0066ff',
    backgroundColor: '#0a0a1a',
  },
},
```
4. Save — the preset appears in the dropdown automatically.

### Adding a new mapping curve preset

1. Open `src/lib/soniccanvas/visuals/MappingCurves.ts`
2. Find `CURVE_PRESETS`
3. Add a new entry with a `make()` factory:
```typescript
{
  id: 'exponential',
  name: 'Exponential',
  description: 'Exponential response — small inputs amplified.',
  make: (key) => ({
    key,
    points: [
      { x: 0, y: 0 },
      { x: 0.1, y: 0.3 },
      { x: 0.3, y: 0.6 },
      { x: 0.6, y: 0.85 },
      { x: 1, y: 1 },
    ],
  }),
},
```
4. Save — the preset button appears in the MappingEditor.

### Modifying a shader

1. Open any scene file (e.g. `LiquidScene.ts`)
2. Find the `FRAG` template literal
3. Look for the `// CUSTOMIZATION:` comments — these mark safe values
4. Change a value and save
5. The browser auto-reloads

**Example:** In LiquidScene, find the domain warping amplitude:
```glsl
float warpAmp = 1.2 + u_distortion * 1.5 + u_bass * 2.5;
```
Try changing `1.2` to `2.0` → more warping at baseline.

### Adding a new keyboard shortcut

1. Open `src/components/soniccanvas/VisualCanvas.tsx`
2. Find the `switch (e.key)` block
3. Add a new case:
```typescript
case 's':
case 'S': {
  // Your action here
  e.preventDefault()
  break
}
```
4. Update `KeyboardShortcutsHelp.tsx` to document it

---

## VSCode Project Setup

See `docs/VSCODE_SETUP.md` for a complete guide to recreating this
project from scratch in VSCode, including folder structure, dependency
installation, and configuration files.
