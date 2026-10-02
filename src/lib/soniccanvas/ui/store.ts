'use client'

import { create } from 'zustand'
import * as THREE from 'three'
import {
  DEFAULT_SETTINGS,
  PRESETS,
  applyPreset,
} from '../config/defaults'
import {
  defaultCurves,
  type MappingCurve,
  type MappingKey,
} from '../visuals/MappingCurves'
import type { SceneId, UserSettings } from '../audio/types'

/**
 * ============================================================================
 * MODULE: ui/store.ts — global Zustand store for the SonicCanvas UI
 * ============================================================================
 *
 * WHAT IT IS
 *   A single Zustand store that owns every piece of UI-facing state in
 *   the app: the current settings, the loaded track, the player state,
 *   the export progress, etc. Components subscribe via `useSonicStore`
 *   and re-render when the slices they read change.
 *
 * WHY IT EXISTS
 *   SonicCanvas has a deeply cross-cutting state shape: the same
 *   `settings` object is read by the ControlsPanel (renders sliders),
 *   the VisualCanvas (passes settings to VisualEngine), the
 *   ControlsPanel's preset dropdown (writes settings), the
 *   DebugOverlay (shows settings for sanity-check), etc. Lifting this
 *   up to React's useState in a shared parent would mean every
 *   settings change re-renders every descendant, including the
 *   VisualCanvas which is doing 60fps work — unacceptable.
 *
 *   Zustand's atomic subscription model means a component that reads
 *   `settings.intensity` only re-renders when that specific slice
 *   changes — the VisualCanvas can read `settings.primaryColor` and
 *   stay subscribed to *just* that slice, ignoring slider changes for
 *   other fields. (Note: this file uses coarse-grained selectors in
 *   practice; for finer-grained updates, components can use Zustand's
 *   `useStore(selector)` with a shallow-equality predicate.)
 *
 * WHY engines are NOT in the store
 *   The AudioEngine, VisualEngine, and VideoExporter are *owned* by a
 *   React component (the top-level SonicCanvas shell) because their
 *   lifetime is tied to the mounted canvas / audio context. Putting
 *   them in the store would re-create them on every HMR and would
 *   couple their lifecycle to React's reconciliation. Instead, they
 *   are exposed via React context (EngineContext.ts) — the store
 *   holds *data*, the context holds *references to engines*.
 *
 * WHAT GOES IN
 *   - setX(...) actions from React components (or from non-React code
 *     via `useSonicStore.getState().setX(...)`).
 *   - On mount: the app may call readSettingsFromHash() and apply the
 *     decoded SerializedSettings to settings/activeScene.
 *
 * WHAT COMES OUT
 *   - The `useSonicStore` React hook (use as `useSonicStore(s => s.x)`
 *     for slice subscriptions, or `useSonicStore()` for the whole state).
 *   - Helper functions `setNumberSetting` / `setColorSetting` that
 *     operate on the singleton state (useful outside React, e.g. from a
 *     vanilla event handler).
 *
 * WHAT DEPENDS ON IT
 *   - Every component under components/soniccanvas/ (reads slices).
 *   - The EngineContext provider (reads settings + writes them when
 *     the user interacts with the canvas / audio engine).
 *   - The app entry (app/page.tsx) reads the screen + applies the
 *     share-URL on mount.
 *
 * WHAT IT DEPENDS ON
 *   - `zustand` (state library).
 *   - `three` (for THREE.Color when applying color writes).
 *   - `../config/defaults` (DEFAULT_SETTINGS, PRESETS, applyPreset).
 *   - `../visuals/MappingCurves` (defaultCurves, MappingCurve, MappingKey).
 *   - `../audio/types` (UserSettings, SceneId contracts).
 *
 * CUSTOMIZATION:
 *   - Add a new state field by adding it to the SonicState interface,
 *     a default value in the create() body, and a setter (if needed).
 *   - Add a derived/computed value as a selector helper, not as a
 *     stored field (so it stays in sync).
 *
 * WARNING:
 *   - Don't mutate nested state objects directly (e.g.
 *     `state.settings.intensity = 2`). Always use the setters (which
 *     produce new top-level objects) so Zustand detects the change.
 *   - The store is a singleton — its state persists across route
 *     changes in the SPA. If you need a clean slate on navigation, add
 *     a `reset()` action and call it from the route's useEffect.
 * ============================================================================
 */

/**
 * Top-level screen the app is showing. Two-state router.
 *   'upload' — no track loaded; UploadScreen is shown.
 *   'studio' — track loaded; the full studio layout (preview + controls +
 *              player bar) is shown.
 *
 * Driven by: setTrack() — passing a track moves to 'studio', null moves
 *   back to 'upload'.
 */
export type Screen = 'upload' | 'studio'

/**
 * Information about the decoded audio track. Set by loadFile() in
 * EngineContext when the user picks a file. Read by the PlayerBar,
 * Header, and footer to display the file name + duration.
 */
export interface LoadedTrack {
  fileName: string
  fileType: string
  duration: number
}

/**
 * Player transport state. Mirrors the AudioEngine's playback state but
 * lives in the store so the UI can re-render on every tick without
 * reaching into the engine directly.
 *
 * `currentTime` is updated by the VisualEngine's RAF loop (it's the
 * canonical audio clock, not a separately-ticking UI timer — see the
 * AudioEngine.getCurrentTime docs).
 */
export interface PlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
}

/**
 * TransitionStyle — how the SceneManager morphs between scenes.
 *   crossfade: opacity 0→1 (default, smooth blend)
 *   wipe:      a diagonal gradient line sweeps across, revealing the
 *              new scene as it passes
 *   zoom:      outgoing scene scales up + fades out; incoming scales
 *              down from 1.2 → 1.0 + fades in (a "punch" transition)
 */
export type TransitionStyle = 'crossfade' | 'wipe' | 'zoom'

/**
 * The full state shape. Fields are grouped by responsibility (UI / settings /
 * playback / export / debug) to make the surface scannable.
 *
 * State-field reference (every field documents what it controls):
 *
 *   -- UI state --
 *   screen              which top-level screen is shown (upload vs. studio)
 *
 *   -- settings (mutable; components subscribe to changes) --
 *   settings            the live UserSettings object (sliders + colors).
 *                       Owned by this store; applied to the VisualMapper
 *                       on each render frame.
 *   activePresetId      the preset id (`'cosmic'`, `'electric'`, `'user:...'`)
 *                       currently selected in the dropdown. WHY stored
 *                       separately: the preset dropdown needs to highlight
 *                       the active entry even after the user tweaks
 *                       individual sliders (which makes the actual
 *                       settings no longer match any preset exactly).
 *   activeScene         the SceneId currently displayed. Drives the
 *                       SceneManager's switchTo() (via EngineContext).
 *   autoScene           when true, the AutoSceneController rotates scenes
 *                       on musical energy changes. Disables the manual
 *                       scene thumbnail strip in the UI.
 *   transitionStyle     how SceneManager morphs between scenes
 *                       (crossfade/wipe/zoom) — see TransitionStyle.
 *   mappingCurves       the per-feature piecewise-linear response curves
 *                       (spec §46 mapping editor). Replaces the previous
 *                       "audio × reaction" linear scaling with a shaped
 *                       curve. `defaultCurves()` returns the identity.
 *   soloFeature         null = all features active; otherwise only the
 *                       named feature ('bass'|'beat'|'treble'|'energy')
 *                       drives the visuals. Useful for debugging +
 *                       "show me what bass is doing right now".
 *
 *   -- track + playback --
 *   track               the LoadedTrack metadata (fileName, duration) or
 *                       null if no track loaded. Drives the upload/studio
 *                       screen flip.
 *   player              transport state (isPlaying, currentTime, duration,
 *                       volume). currentTime is updated every frame.
 *   isAnalyzing         true while the AudioEngine is decoding a freshly
 *                       picked file. Drives the UploadScreen's spinner.
 *
 *   -- export --
 *   isExporting         true while VideoExporter.export() is running.
 *                       Drives the ExportDialog's progress bar.
 *   exportProgress      0..1 progress through the track. Updated by the
 *                       exporter's onProgress callback.
 *   exportBlobUrl      object URL for the produced WebM blob, after
 *                       export resolves. Null while exporting / before
 *                       the user clicks download. Freed by the
 *                       closeExportBlob action (EngineContext).
 *   error               the last user-facing error message, or null.
 *                       Set by the engines on failure; the UI shows it
 *                       as a toast / banner.
 *
 *   -- debug --
 *   debug               when true, the DebugOverlay renders (FPS, audio
 *                       feature bars, scene + resolution info). Toggled
 *                       from the ControlsPanel advanced accordion.
 */
interface SonicState {
  // UI
  screen: Screen
  // settings (mutable; components subscribe to changes)
  settings: UserSettings
  activePresetId: string
  activeScene: SceneId
  // auto-scene mode: visual engine rotates scenes based on energy
  autoScene: boolean
  // scene transition style (crossfade / wipe / zoom)
  transitionStyle: TransitionStyle
  // audio→visual mapping curves (spec §46 — mapping editor)
  mappingCurves: Record<MappingKey, MappingCurve>
  // solo mode: null = all features active; 'bass'|'beat'|'treble'|'energy' = only that feature
  soloFeature: MappingKey | null
  // track + playback
  track: LoadedTrack | null
  player: PlayerState
  isAnalyzing: boolean
  // export
  isExporting: boolean
  exportProgress: number
  exportBlobUrl: string | null
  error: string | null
  // debug
  debug: boolean

  // setters
  setScreen: (s: Screen) => void
  setTrack: (t: LoadedTrack | null) => void
  setPlayer: (p: Partial<PlayerState>) => void
  setAnalyzing: (v: boolean) => void
  setScene: (s: SceneId) => void
  setAutoScene: (v: boolean) => void
  setTransitionStyle: (s: TransitionStyle) => void
  setMappingCurves: (c: Record<MappingKey, MappingCurve>) => void
  setMappingCurve: (key: MappingKey, curve: MappingCurve) => void
  setSoloFeature: (f: MappingKey | null) => void
  setPreset: (id: string) => void
  updateSettings: (patch: Partial<UserSettings>) => void
  setError: (e: string | null) => void
  setDebug: (v: boolean) => void
  setExporting: (v: boolean) => void
  setExportProgress: (p: number) => void
  setExportBlobUrl: (u: string | null) => void
}

/**
 * The Zustand store. The `create` callback returns the initial state
 * object + all the setter functions.
 *
 * WHY every setter is one-liner: Zustand's `set` already handles
 * immutability; the setters here are thin wrappers that give us a
 * stable API surface (so callers don't reach into `set` directly and
 * accidentally mutate nested fields).
 */
export const useSonicStore = create<SonicState>((set, get) => ({
  // --- UI ---
  screen: 'upload', // cold-start on the upload screen

  // --- settings ---
  // DEFAULT_SETTINGS is the bootstrap; subsequent changes go through
  // updateSettings / setPreset which produce new top-level objects.
  settings: DEFAULT_SETTINGS,
  // 'cosmic' is the cold-start preset id; matches the first entry in
  // PRESETS so the dropdown highlights it on first paint.
  activePresetId: 'cosmic',
  // 'liquid' is the cold-start scene — matches the first entry in
  // SCENES so the thumbnail strip highlights it on first paint.
  activeScene: 'liquid',
  // Auto-scene is off by default — the user opts in once they're
  // happy with the basic look.
  autoScene: false,
  // Crossfade is the default transition — smoothest visual result.
  transitionStyle: 'crossfade',
  // Identity curves — preserves the linear audio × reaction scaling
  // the VisualMapper used before curves were added (spec §46).
  mappingCurves: defaultCurves(),
  // No solo on cold-start — all features contribute equally.
  soloFeature: null,

  // --- track + playback ---
  // No track on cold-start; user uploads first.
  track: null,
  // Stopped, at 0, no duration, full volume.
  player: { isPlaying: false, currentTime: 0, duration: 0, volume: 1.0 },
  // Not decoding anything on cold-start.
  isAnalyzing: false,

  // --- export ---
  isExporting: false,
  exportProgress: 0,
  // No blob yet — set after export resolves.
  exportBlobUrl: null,
  // No error on cold-start.
  error: null,

  // --- debug ---
  // Debug overlay hidden by default — power users opt in.
  debug: false,

  // --- setters ---
  // Single-line setters that wrap Zustand's `set` to give a stable
  // API. Each one creates a new top-level state object so subscribers
  // see the change.
  setScreen: (s) => set({ screen: s }),
  setTrack: (t) => set({ track: t }),
  // Player uses a partial merge so callers can update a single
  // field (e.g. just `currentTime`) without rebuilding the whole
  // PlayerState object every frame.
  setPlayer: (p) => set((st) => ({ player: { ...st.player, ...p } })),
  setAnalyzing: (v) => set({ isAnalyzing: v }),
  setScene: (s) => set({ activeScene: s }),
  setAutoScene: (v) => set({ autoScene: v }),
  setTransitionStyle: (s) => set({ transitionStyle: s }),
  setMappingCurves: (c) => set({ mappingCurves: c }),
  // Per-curve update: spreads the existing curves + overrides one key.
  // WHY not just Object.assign: the spread here produces a new
  // top-level object so Zustand detects the change; Object.assign on
  // the existing object would mutate in place and subscribers wouldn't
  // re-render.
  setMappingCurve: (key, curve) =>
    set((st) => ({ mappingCurves: { ...st.mappingCurves, [key]: curve } })),
  setSoloFeature: (f) => set({ soloFeature: f }),
  // Preset application — looks up the preset by id, calls
  // defaults.applyPreset (handles hex → THREE.Color), writes the new
  // settings + the activePresetId. Built-in presets only here; user
  // presets go through the separate presetStorage.applyAnyPreset path.
  setPreset: (id) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    const next = applyPreset(get().settings, preset)
    set({ settings: next, activePresetId: id })
  },
  // updateSettings — patch-style merge for any subset of UserSettings.
  // Used by the slider onChange handlers (via setNumberSetting) and
  // the color picker onChange (via setColorSetting). Produces a new
  // top-level settings object so subscribers see the change.
  updateSettings: (patch) =>
    set((st) => ({ settings: { ...st.settings, ...patch } })),
  setError: (e) => set({ error: e }),
  setDebug: (v) => set({ debug: v }),
  setExporting: (v) => set({ isExporting: v }),
  setExportProgress: (p) => set({ exportProgress: p }),
  setExportBlobUrl: (u) => set({ exportBlobUrl: u }),
}))

/**
 * Helper to update a single numeric setting.
 *
 * WHY a helper (vs. calling `useSonicStore.getState().updateSettings(...)`
 * inline): the slider components all share the same onChange shape
 * `(value: number) => void`. This helper produces a function with that
 * exact signature, so a slider can do `onChange={setNumberSetting('intensity')}`
 * without an arrow-function wrapper.
 *
 * Uses `getState()` (not the hook) so it can be called from non-React
 * contexts — e.g. inside a vanilla event handler or a Three.js
 * click-callback.
 */
export function setNumberSetting<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K]
) {
  useSonicStore.getState().updateSettings({ [key]: value } as Partial<UserSettings>)
}

/**
 * Helper to update a color setting from a hex string.
 *
 * Converts the hex string into a THREE.Color before writing, so the
 * store always holds THREE.Color instances (which the renderer reads
 * directly — no per-frame hex parsing).
 *
 * WHY a typed key restriction: only `primaryColor`, `secondaryColor`,
 * and `backgroundColor` are color fields in UserSettings. Restricting
 * the key prevents accidentally calling this with `'intensity'` (which
 * would compile but produce a THREE.Color in a number field).
 */
export function setColorSetting(
  key: 'primaryColor' | 'secondaryColor' | 'backgroundColor',
  hex: string
) {
  useSonicStore.getState().updateSettings({ [key]: new THREE.Color(hex) } as Partial<UserSettings>)
}
