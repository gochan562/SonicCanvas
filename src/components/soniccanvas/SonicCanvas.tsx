'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EngineContext, type EngineActions } from '../../lib/soniccanvas/ui/EngineContext'
import { AudioEngine } from '../../lib/soniccanvas/audio/AudioEngine'
import { VisualEngine } from '../../lib/soniccanvas/visuals/VisualEngine'
import { VideoExporter } from '../../lib/soniccanvas/export/VideoExporter'
import { useSonicStore } from '../../lib/soniccanvas/ui/store'
import { VisualCanvas } from './VisualCanvas'
import { UploadScreen } from './UploadScreen'
import { ControlsPanel } from './ControlsPanel'
import { PlayerBar } from './PlayerBar'
import { ExportDialog } from './ExportDialog'
import { SavePresetDialog } from './SavePresetDialog'
import { SharePresetDialog } from './SharePresetDialog'
import { FullscreenToggle } from './FullscreenToggle'
import { DebugOverlay } from './DebugOverlay'
import { NowPlayingOverlay } from './NowPlayingOverlay'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'
import { Header } from './Header'
import { Toaster } from '@/components/ui/toaster'
import { readSettingsFromHash, clearSettingsHash, deserializeSettings } from '@/lib/soniccanvas/config/shareUrl'
import type { SceneId } from '@/lib/soniccanvas/audio/types'
import { toast } from '@/hooks/use-toast'

/**
 * SonicCanvas
 *
 * Top-level app shell. Owns the audio + visual + export engine
 * instances (created in refs so they survive re-renders) and exposes
 * a small action API to all children via EngineContext.
 *
 * Layout (spec §23):
 *
 *   ┌─ Header ─────────────────────────────────────────────┐
 *   │  SonicCanvas logo                      Export button  │
 *   ├──────────────────────────────────────┬────────────────┤
 *   │                                       │                │
 *   │           Visual preview              │  Controls      │
 *   │                                       │  panel         │
 *   ├──────────────────────────────────────┴────────────────┤
 *   │  Player bar (play / seek / volume / file info)         │
 *   └────────────────────────────────────────────────────────┘
 *
 * Footer is sticky (per project UI rules) and pushed down naturally
 * on tall content via a min-h-screen flex column wrapper.
 */
export function SonicCanvas() {
  const audioRef = useRef<AudioEngine | null>(null)
  const visualRef = useRef<VisualEngine | null>(null)
  const exporterRef = useRef<VideoExporter | null>(null)
  const [ready, setReady] = useState(false)

  // Pull state + setters from the store
  const settings = useSonicStore((s) => s.settings)
  const screen = useSonicStore((s) => s.screen)
  const setScreen = useSonicStore((s) => s.setScreen)
  const setTrack = useSonicStore((s) => s.setTrack)
  const setPlayer = useSonicStore((s) => s.setPlayer)
  const setError = useSonicStore((s) => s.setError)
  const setAnalyzing = useSonicStore((s) => s.setAnalyzing)
  const setExporting = useSonicStore((s) => s.setExporting)
  const setExportProgress = useSonicStore((s) => s.setExportProgress)
  const setExportBlobUrl = useSonicStore((s) => s.setExportBlobUrl)
  const setSceneStore = useSonicStore((s) => s.setScene)
  const activeScene = useSonicStore((s) => s.activeScene)

  // ---- engine lifecycle -------------------------------------------------
  // Engines are created lazily so we don't run on the server.
  useEffect(() => {
    if (audioRef.current) return
    audioRef.current = new AudioEngine()
    exporterRef.current = new VideoExporter()
    // subscribe to audio engine state to keep the store in sync
    const unsub = audioRef.current.subscribe((st) => {
      setPlayer({
        isPlaying: st.isPlaying,
        currentTime: st.currentTime,
        duration: st.duration,
        volume: st.volume,
      })
    })
    setReady(true)
    return () => {
      unsub()
      audioRef.current?.dispose()
      audioRef.current = null
      visualRef.current?.dispose()
      visualRef.current = null
    }
  }, [])

  // ---- settings sync -----------------------------------------------------
  // Whenever settings change, push them into the visual engine so its
  // shaders receive the new uniforms.
  useEffect(() => {
    visualRef.current?.setSettings(settings)
  }, [settings])

  // ---- transition style sync ---------------------------------------------
  const transitionStyle = useSonicStore((s) => s.transitionStyle)
  useEffect(() => {
    visualRef.current?.setTransitionStyle(transitionStyle)
  }, [transitionStyle])

  // ---- mapping curves sync -----------------------------------------------
  const mappingCurves = useSonicStore((s) => s.mappingCurves)
  useEffect(() => {
    visualRef.current?.setMappingCurves(mappingCurves)
  }, [mappingCurves])

  // ---- solo feature sync -------------------------------------------------
  const soloFeature = useSonicStore((s) => s.soloFeature)
  useEffect(() => {
    visualRef.current?.setSoloFeature(soloFeature)
  }, [soloFeature])

  // ---- shared-preset URL hash -------------------------------------------
  // On mount, check if the URL contains a #preset=<blob> hash. If so,
  // deserialize the settings + apply them to the store, then clear
  // the hash so a refresh doesn't re-apply a stale preset.
  const [sharedPresetScene, setSharedPresetScene] = useState<string | null>(null)
  useEffect(() => {
    const shared = readSettingsFromHash()
    if (!shared) return
    const next = deserializeSettings(shared)
    const { activeScene: sharedScene, mappingCurves: sharedCurves, ...patch } = next
    useSonicStore.getState().updateSettings(patch)
    if (sharedScene) {
      const sid = sharedScene as SceneId
      useSonicStore.getState().setScene(sid)
    }
    if (sharedCurves) {
      useSonicStore.getState().setMappingCurves(sharedCurves)
    }
    clearSettingsHash()
    setSharedPresetScene(sharedScene ?? '')
  }, [])

  // Fire the "shared preset applied" toast AFTER the component has
  // mounted + hydrated (the radix Toaster is in the layout).
  useEffect(() => {
    if (sharedPresetScene === null) return
    toast({
      title: 'Shared preset applied',
      description: sharedPresetScene
        ? `Scene: ${sharedPresetScene} · Colors and mappings loaded from URL.`
        : 'Colors and mappings loaded from URL.',
    })
  }, [sharedPresetScene])

  // ---- actions ----------------------------------------------------------
  const loadFile = useCallback<EngineActions['loadFile']>(async (file) => {
    if (!audioRef.current) return
    setAnalyzing(true)
    setError(null)
    try {
      const res = await audioRef.current.loadFile(file)
      setTrack({
        fileName: res.fileName,
        fileType: res.fileType,
        duration: res.duration,
      })
      setScreen('studio')
      setPlayer({
        isPlaying: false,
        currentTime: 0,
        duration: res.duration,
        volume: audioRef.current.getVolume(),
      })
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load audio')
    } finally {
      setAnalyzing(false)
    }
  }, [audioRef, setAnalyzing, setError, setTrack, setScreen, setPlayer])

  const play = useCallback(async () => {
    await audioRef.current?.play()
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const seek = useCallback(async (t: number) => {
    await audioRef.current?.seek(t)
  }, [])

  const setVolume = useCallback((v: number) => {
    audioRef.current?.setVolume(v)
  }, [])

  const setScene = useCallback((s: 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles') => {
    visualRef.current?.setScene(s)
    setSceneStore(s)
  }, [setSceneStore])

  const setAutoSceneMode = useCallback((enabled: boolean) => {
    visualRef.current?.setAutoSceneMode(enabled)
    useSonicStore.getState().setAutoScene(enabled)
  }, [])

  const exportVideo = useCallback<EngineActions['export']>(async (opts) => {
    if (!audioRef.current || !visualRef.current || !exporterRef.current) return
    if (!VideoExporter.isSupported()) {
      setError('Your browser does not support in-browser video export. Try Chrome, Edge, or Firefox.')
      return
    }
    setExporting(true)
    setExportProgress(0)
    setExportBlobUrl(null)
    setError(null)
    // pause any current playback first
    if (audioRef.current.isCurrentlyPlaying()) audioRef.current.pause()
    // pause the FPS auto-scaler so it doesn't fight the exporter's
    // explicit resolution target
    visualRef.current.setExportActive(true)
    try {
      const blob = await exporterRef.current.export(
        audioRef.current,
        visualRef.current,
        opts,
        (p) => setExportProgress(p.progress)
      )
      const url = URL.createObjectURL(blob)
      setExportBlobUrl(url)
    } catch (e: any) {
      setError(e?.message ?? 'Export failed')
    } finally {
      visualRef.current.setExportActive(false)
      setExporting(false)
      // reset play head so the user can preview again
      await audioRef.current.seek(0)
    }
  }, [audioRef, visualRef, exporterRef, setExporting, setExportProgress, setExportBlobUrl, setError])

  const cancelExport = useCallback(() => {
    exporterRef.current?.cancel()
    setExporting(false)
  }, [exporterRef, setExporting])

  const closeExportBlob = useCallback(() => {
    const url = useSonicStore.getState().exportBlobUrl
    if (url) URL.revokeObjectURL(url)
    setExportBlobUrl(null)
  }, [setExportBlobUrl])

  // re-render when the active scene changes (so VisualCanvas gets it)
  useEffect(() => {
    if (visualRef.current) {
      visualRef.current.setScene(activeScene)
    }
  }, [activeScene])

  const ctxValue = useMemo<EngineActions>(() => ({
    audio: audioRef.current!,
    visual: visualRef.current!,
    exporter: exporterRef.current!,
    loadFile,
    play,
    pause,
    seek,
    setVolume,
    setScene,
    setAutoSceneMode,
    export: exportVideo,
    cancelExport,
    closeExportBlob,
  }), [audioRef.current, visualRef.current, exporterRef.current, loadFile, play, pause, seek, setVolume, setScene, setAutoSceneMode, exportVideo, cancelExport, closeExportBlob])

  return (
    <EngineContext.Provider value={ctxValue}>
      <div className="relative min-h-screen flex flex-col bg-[#05030d] text-white">
        <Header />
        <main className="flex-1 flex flex-col lg:flex-row gap-3 p-3">
          {/* Visual preview area */}
          <section className="animate-sonic-canvas-fade relative flex-1 min-h-[50vh] lg:min-h-0 rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl shadow-black/50">
            {ready && (
              <VisualCanvas
                audioRef={audioRef}
                visualRef={visualRef}
                onCanvasReady={(canvas) => {
                  // create the visual engine when the canvas is mounted
                  if (visualRef.current || !audioRef.current) return
                  visualRef.current = new VisualEngine(canvas, audioRef.current)
                  visualRef.current.init(settings)
                  visualRef.current.setSettings(settings)
                  visualRef.current.setScene(activeScene)
                  visualRef.current.start()
                  // expose for DebugOverlay + stats event dispatch
                  ;(window as any).__sonicAudio = audioRef.current
                  ;(window as any).__sonicVisual = visualRef.current
                  visualRef.current.onStats((s) => {
                    window.dispatchEvent(
                      new CustomEvent('soniccanvas:stats', { detail: s })
                    )
                  })
                  // when auto-scene rotates scenes, sync the store so
                  // the UI reflects the new active scene.
                  visualRef.current.getAutoScene().onSceneChanged = (id) => {
                    useSonicStore.getState().setScene(id)
                  }
                }}
              />
            )}
            <DebugOverlay />
            <NowPlayingOverlay />
            <FullscreenToggle />
            {screen === 'upload' && <UploadScreen />}
          </section>
          <ControlsPanel />
        </main>
        <PlayerBar />
        <KeyboardShortcutsHelp />
        <SavePresetDialog />
        <SharePresetDialog />
        <Toaster />
        <footer className="mt-auto border-t border-white/10 bg-gradient-to-r from-black/80 via-[#0a0512]/80 to-black/80 px-4 py-2.5 text-xs text-white/40 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="sonc-live-dot inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>
                SonicCanvas — procedural music-video generator. All processing happens
                locally in your browser.
              </span>
            </div>
            <div className="hidden items-center gap-3 text-[10px] uppercase tracking-wider text-white/30 sm:flex">
              <span>WebGL · Web Audio · Three.js</span>
              <span className="text-white/20">·</span>
              <span>no server · no upload · no AI</span>
            </div>
          </div>
        </footer>
        <ExportDialog />
      </div>
    </EngineContext.Provider>
  )
}
