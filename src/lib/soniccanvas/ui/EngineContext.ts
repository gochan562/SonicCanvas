'use client'

import { createContext, useContext } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import type { VisualEngine } from '../visuals/VisualEngine'
import type { VideoExporter } from '../export/VideoExporter'

/**
 * ============================================================================
 * MODULE: ui/EngineContext.ts — React context for the three engine instances
 * ============================================================================
 *
 * WHAT IT IS
 *   A typed React context + a `useEngines` hook that returns the three
 *   long-lived engine singletons (AudioEngine, VisualEngine, VideoExporter)
 *   plus a set of imperative actions (play, pause, seek, setVolume, etc.)
 *   that wrap those engines.
 *
 * WHY IT EXISTS
 *   The Zustand store (store.ts) owns *data* (settings, player state,
 *   export progress). It does NOT own the engines, because the engines
 *   have lifecycle constraints that don't fit Zustand's plain-data model:
 *
 *     - AudioEngine owns an AudioContext — created on first user gesture
 *       per browser autoplay policy. Can't be a plain store field.
 *     - VisualEngine owns a Three.js WebGLRenderer — bound to a specific
 *       <canvas> element; re-created if the canvas unmounts.
 *     - VideoExporter owns a MediaRecorder + MediaStream — short-lived
 *       (only during an active export).
 *
 *   These belong to the React component that mounts the canvas (the
 *   SonicCanvas shell). React context is the standard way to share such
 *   long-lived instances with descendants without prop-drilling.
 *
 *   Two-tier state model:
 *     - Zustand store  → data (settings, player state, export progress).
 *     - EngineContext → behavior (engine references + imperative actions).
 *
 *   A component like PlayerBar reads both: it reads `player.isPlaying`
 *   from the store to render the play/pause button label, AND calls
 *   `engines.play()` from EngineContext to actually start playback when
 *   the button is clicked. The store mutation + the engine call happen
 *   together inside the same onClick handler.
 *
 * WHAT GOES IN
 *   - A single `EngineActions` object provided by the SonicCanvas shell
 *     via `<EngineContext.Provider value={actions}>`.
 *   - The shell constructs the engines in a `useRef` (so they persist
 *     across re-renders), wires their callbacks to the store setters
 *     (e.g. `audio.onTimeUpdate = (t) => store.setPlayer({ currentTime: t })`),
 *     and assembles the `EngineActions` object with `useMemo`.
 *
 * WHAT COMES OUT
 *   - `EngineContext` — the raw React context (rarely used directly).
 *   - `useEngines()` — the hook consumers call. Throws if called
 *     outside the provider — this is intentional, since a component
 *     that needs engines is structurally broken if it's outside the
 *     provider.
 *
 * WHAT DEPENDS ON IT
 *   - components/soniccanvas/SonicCanvas.tsx (creates the provider).
 *   - components/soniccanvas/VisualCanvas.tsx (reads `visual` to drive
 *     the RAF loop + scene switching).
 *   - components/soniccanvas/UploadScreen.tsx (calls `loadFile` on drop).
 *   - components/soniccanvas/ControlsPanel.tsx (calls `setScene`,
 *     `setAutoSceneMode` on user interactions).
 *   - components/soniccanvas/PlayerBar.tsx (calls `play`, `pause`,
 *     `seek`, `setVolume`).
 *   - components/soniccanvas/ExportDialog.tsx (calls `export`,
 *     `cancelExport`, `closeExportBlob`).
 *
 * WHAT IT DEPENDS ON
 *   - React (`createContext`, `useContext`).
 *   - The three engine classes (as type-only imports — we don't
 *     instantiate them here; the SonicCanvas shell does).
 *
 * CUSTOMIZATION:
 *   - Add a new imperative action (e.g. `loadFromUrl(url)`) by
 *     extending the EngineActions interface + implementing it in the
 *     SonicCanvas shell's `useMemo` block.
 *   - For a non-React context (e.g. a vanilla Three.js event handler),
 *     you can reach the engines via a ref returned by a separate hook —
 *     but the canonical pattern is to keep the handler in a React
 *     component so it can use `useEngines`.
 *
 * WARNING:
 *   - The engines are NOT available on cold-start server render. The
 *     provider is `'use client'` and the engines are created in a
 *     `useEffect`/`useRef` — components that read `useEngines()` must
 *     guard against being rendered before the provider is mounted.
 *   - The hook throws if called outside the provider. This is
 *     deliberate — failing fast at render time surfaces wiring bugs
 *     early instead of producing silent null dereferences.
 * ============================================================================
 */

/**
 * The contract the SonicCanvas shell provides to its descendants via
 * EngineContext. Bundles:
 *   - Direct engine references (audio, visual, exporter) — for
 *     components that need to call methods not wrapped by an action.
 *   - High-level actions (loadFile, play, pause, seek, setVolume,
 *     setScene, setAutoSceneMode, export, cancelExport,
 *     closeExportBlob) — the common operations every UI component
 *     needs, wrapped to also update the Zustand store.
 *
 * WHY bundle actions + references: components shouldn't have to import
 *   the store separately just to call play(). The actions encapsulate
 *   the cross-cutting "engine call + store mutation" pattern so
 *   components stay declarative (one onClick → one action call →
 *   engine + store both update).
 */
export interface EngineActions {
  // Direct engine references — the three singletons.
  audio: AudioEngine
  visual: VisualEngine
  exporter: VideoExporter

  /**
   * Decode a user-picked audio File and load it into the AudioEngine.
   * Sets store.track on success, store.error on failure. Triggers
   * the upload → studio screen flip.
   */
  loadFile: (file: File) => Promise<void>

  /**
   * Start playback from the current position (or from 0 if first play).
   * Sets store.player.isPlaying = true. WHY a Promise: the underlying
   * AudioContext.resume() is async (browser autoplay policy may
   * require a user gesture to resolve).
   */
  play: () => Promise<void>

  /** Pause playback. Sets store.player.isPlaying = false. */
  pause: () => void

  /**
   * Seek to an absolute time in seconds. WHY a Promise: the AudioEngine
   * has to stop the current source node + create a new one (Web Audio
   * doesn't allow seeking an AudioBufferSourceNode in place).
   */
  seek: (t: number) => Promise<void>

  /** Set the master volume (0..1). Updates store.player.volume. */
  setVolume: (v: number) => void

  /**
   * Switch to a procedural scene. Calls SceneManager.switchTo which
   * triggers a crossfade (or wipe / zoom) transition.
   */
  setScene: (s: 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles') => void

  /**
   * Enable / disable AutoSceneController. When enabled, the visual
   * engine rotates scenes on musical energy changes; the manual
   * scene selector in the UI is disabled.
   */
  setAutoSceneMode: (enabled: boolean) => void

  /**
   * Run a clean WebM export (see VideoExporter.export). Sets
   * store.isExporting = true, drives exportProgress, sets
   * exportBlobUrl when the blob resolves.
   */
  export: (opts: { resolution: '720p' | '1080p' | 'preview'; quality: 'low' | 'medium' | 'high' }) => Promise<void>

  /** Abort an in-progress export. The partial blob (if any) is
   *  still delivered to store.exportBlobUrl. */
  cancelExport: () => void

  /**
   * Free the object URL produced by a previous export. Called when
   * the user closes the ExportDialog after download. WHY an explicit
   * action (vs. relying on GC): URL.createObjectURL holds a strong
   * reference to the Blob until URL.revokeObjectURL is called —
   * leaking the URL means the Blob stays in memory too.
   */
  closeExportBlob: () => void
}

/**
 * The React context itself. Held as `null` so `useContext` returns
 * null when no provider is mounted — the `useEngines` hook turns that
 * null into an explicit throw so the caller surfaces the wiring bug.
 *
 * WHY not a default value (vs. null): a default value would silently
 *   satisfy components that called `useContext` outside the provider —
 *   they'd get an object whose methods no-op'd and the bug would only
 *   surface when the user clicked the corresponding UI control. Throwing
 *   at render time is far noisier and easier to debug.
 */
export const EngineContext = createContext<EngineActions | null>(null)

/**
 * Hook to read the EngineActions. Must be called inside a component
 * mounted under `<EngineContext.Provider>`.
 *
 * Throws an explicit Error if called outside the provider — see the
 * EngineContext doc block for why we fail fast.
 */
export function useEngines(): EngineActions {
  const ctx = useContext(EngineContext)
  if (!ctx) throw new Error('useEngines must be used inside <EngineContext.Provider>')
  return ctx
}
